/**
 * `nexus check [--json]` and `nexus check --last [--json]`: ask GitHub,
 * read-only, which Installed Skills are Behind, and say the Check Result.
 *
 * A Skill is Behind when the folder it came from has a commit newer than the
 * moment it was installed or last updated. Commit dates are the road because
 * nothing else can answer: `skillFolderHash` is upstream `npx skills`' own
 * hash, and the lock records no commit, tag or version. The folder, not the
 * recorded `skillPath`, is what GitHub is asked about, because a Skill is its
 * folder; a Skill whose SKILL.md is the root of its repository asks about the
 * whole repository.
 *
 * The check applies nothing: no Skill, no Managed Link and no line of the
 * Nexus Lock moves. The one file it writes is the Check Result beside the
 * lock, written whole through a temporary file and one rename. `--last`
 * prints that file and asks GitHub nothing, so it needs neither `gh` nor the
 * lock. `unknown` always carries a reason and never counts as `current`,
 * because unknown must never read as good news.
 *
 * Every sentence and every byte of output is the Bash CLI's (`check_skills`):
 * the JSON in jq's pretty form, the table as
 * jq's `@tsv` writes it.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from './cli.ts';
import { reachesFile } from './entries.ts';
import { usageRefusal } from './help.ts';
import { compactJson, isObject, prettyJson } from './json.ts';
import { lockField, type NexusLock, readLock } from './lock.ts';
import { error } from './output.ts';
import { type Paths, readPaths } from './paths.ts';
import { findProgram, runProgram } from './run-program.ts';
import { byteOrder } from './skill-names.ts';

/** The state of one Installed Skill: one lowercase word a page can use as it is. */
type State = 'current' | 'behind' | 'unknown';

/** What the lock says about one Installed Skill, as the check needs it. */
type LockRow = {
  readonly name: string;
  readonly source: string;
  readonly kind: string;
  readonly folder: string;
  readonly updated: string;
};

/** One row of the Check Result, in the key order of the Bash CLI. */
type ResultRow = {
  readonly name: string;
  readonly state: State;
  readonly source: string | null;
  readonly folder: string;
  readonly updatedAt: string | null;
  readonly committedAt: string | null;
  readonly reason: string | null;
};

/** The Check Result document, as the file holds it and `--json` prints it. */
type CheckResult = {
  readonly checkedAt: string;
  readonly counts: { readonly current: number; readonly behind: number; readonly unknown: number };
  readonly skills: readonly ResultRow[];
};

/** What jq's `@tsv` writes for each character it escapes. */
const TSV_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
};

/** The prefix of the temporary Check Result in the Nexus home. */
const TEMP_PREFIX = '.nexus-tmp.check.';

/** Check the Installed Skills, or print the last result; exit 0, 1 on a refusal, 2 on usage. */
export const check: Command = async (args) => {
  let json = false;
  let last = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--last') last = true;
    else return usageRefusal();
  }
  const paths = readPaths();
  if (last) return lastResult(paths, json);

  // Both refusals about gh come before any file is read: a check that cannot
  // ask is not a check, and the sentence a person needs is about their machine.
  const gh = findProgram('gh');
  if (gh === undefined) {
    error('the GitHub CLI is not available: install gh, then run gh auth login');
    return 1;
  }
  if (runProgram(gh, ['auth', 'status'], { stdio: 'ignore' }).status !== 0) {
    error('the GitHub CLI is not logged in: run gh auth login');
    return 1;
  }

  // A missing lock is a refusal, not an empty result: "no skills, nothing
  // behind" would be a sentence a caller acts on, and it would not be true.
  if (!reachesFile(paths.lock)) {
    error(`lock is absent: ${paths.lock}`);
    return 1;
  }
  const read = readLock(paths.lock, paths.nexusHome);
  if (!read.ok) {
    for (const sentence of read.errors) error(sentence);
    return 1;
  }

  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // Grouped by repository, so the calls to one repository happen together.
  const rows = lockRows(read.lock).toSorted(
    (a, b) => byteOrder(a.source, b.source) || byteOrder(a.name, b.name),
  );
  const checked = rows.map((row) => checkRow(gh, row));
  const count = (state: State) => checked.filter((row) => row.state === state).length;
  const document: CheckResult = {
    checkedAt,
    counts: { current: count('current'), behind: count('behind'), unknown: count('unknown') },
    skills: checked.toSorted((a, b) => byteOrder(a.name, b.name)),
  };
  const fault = writeResult(paths, document);
  if (fault !== undefined) {
    error(fault);
    return 1;
  }
  answer(paths, document, json);
  return 0;
};

/**
 * The Check Result as it stands, with no question asked of anybody. A result
 * that is not there and one that is not a result are each one sentence and
 * exit 1, so that a caller that shows marks shows none.
 */
function lastResult(paths: Paths, json: boolean): number {
  if (!reachesFile(paths.checkResult)) {
    error(`no check has run yet: run nexus check to write ${paths.checkResult}`);
    return 1;
  }
  const document = readResult(paths.checkResult);
  if (document === undefined) {
    error(`the check result is unreadable: run nexus check to write ${paths.checkResult} again`);
    return 1;
  }
  answer(paths, document, json);
  return 0;
}

/** The document in `file` when it has the shape of a Check Result, else undefined. */
function readResult(file: string): Readonly<Record<string, unknown>> | undefined {
  let document: unknown;
  try {
    // jq skips a leading byte order mark; JSON.parse does not.
    document = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  if (!isObject(document)) return undefined;
  if (typeof document.checkedAt !== 'string') return undefined;
  if (!isObject(document.counts) || !Array.isArray(document.skills)) return undefined;
  return document;
}

/**
 * What the lock says of each Installed Skill: its repository, its folder (the
 * `skillPath` without its last segment, empty at the root of a repository),
 * and the moment it was last updated, or installed when it never was.
 */
function lockRows(lock: NexusLock): readonly LockRow[] {
  return lock.names.map((name) => {
    const path = text(lockField(lock, name, 'skillPath'));
    const slash = path.lastIndexOf('/');
    return {
      name,
      source: text(lockField(lock, name, 'source')),
      kind: text(lockField(lock, name, 'sourceType')),
      folder: slash === -1 ? '' : path.slice(0, slash),
      updated: text(
        lockField(lock, name, 'updatedAt') ?? lockField(lock, name, 'installedAt'),
      ),
    };
  });
}

/** Ask GitHub about one Installed Skill, and judge it. */
function checkRow(gh: string, row: LockRow): ResultRow {
  const result = (state: State, committed: string, reason: string): ResultRow => ({
    name: row.name,
    state,
    source: row.source === '' ? null : row.source,
    folder: row.folder,
    updatedAt: row.updated === '' ? null : row.updated,
    committedAt: committed === '' ? null : committed,
    reason: reason === '' ? null : reason,
  });
  if (row.source === '' || row.kind !== 'github') {
    return result('unknown', '', `the lock records no GitHub repository for ${row.name}`);
  }
  if (row.updated === '') {
    return result('unknown', '', `the lock records no install date for ${row.name}`);
  }
  // The committer date, not the author date: the moment the folder actually
  // moved on the branch a person installs from.
  const args = ['api', '-X', 'GET', `repos/${row.source}/commits`, '-f', 'per_page=1'];
  if (row.folder !== '') args.push('-f', `path=${row.folder}`);
  args.push('--jq', '.[0].commit.committer.date // empty');
  const run = runProgram(gh, args);
  if (run.status !== 0) {
    const said = `(gh exited ${run.status}): ${firstLine(run.stderr)}`;
    return result('unknown', '', `could not reach ${row.source} ${said}`);
  }
  // A command substitution drops every trailing newline.
  const committed = run.stdout.replace(/\n+$/, '');
  if (committed === '') {
    const what = row.folder === '' ? 'the repository' : row.folder;
    return result('unknown', '', `no commit in ${row.source} touches ${what}`);
  }
  const upstream = epoch(committed);
  const installed = epoch(row.updated);
  if (upstream === undefined || installed === undefined) {
    return result('unknown', committed, `cannot compare ${row.updated} with ${committed}`);
  }
  return result(upstream > installed ? 'behind' : 'current', committed, '');
}

/**
 * The first non-empty line of what gh said, so the Check Result explains
 * itself. As `while read` does, only a line that ends in a newline counts.
 */
function firstLine(stderr: string): string {
  const lines = stderr.split('\n').slice(0, -1);
  return lines.find((line) => line !== '') ?? '';
}

/** A moment that names its zone: a `Z`, an offset, or the name of a zone. */
const ZONED = /(?:\dZ|[+-]\d{2}:?\d{2}|\b(?:UTC|GMT|UT|[ECMP][SD]T)\b.*)$/i;

/** A date with no time, which `Date.parse` already reads as UTC. */
const DATE_ONLY = /^[+-]?\d{4,6}(?:-\d{2}){0,2}$/;

/**
 * A moment as whole seconds since the epoch, as `date -u -d <moment> +%s`
 * gives it: a moment that names no zone is UTC, whatever zone the machine is
 * in, and a fraction is cut off.
 */
function epoch(moment: string): number | undefined {
  const given = moment.trim();
  const ms = Date.parse(given);
  if (Number.isNaN(ms)) return undefined;
  if (DATE_ONLY.test(given) || ZONED.test(given)) return Math.floor(ms / 1000);
  // `Date.parse` read the wall time in the local zone: read it again as UTC.
  const wall = new Date(ms);
  const utc = Date.UTC(
    wall.getFullYear(),
    wall.getMonth(),
    wall.getDate(),
    wall.getHours(),
    wall.getMinutes(),
    wall.getSeconds(),
    wall.getMilliseconds(),
  );
  return Math.floor(utc / 1000);
}

/**
 * Write the Check Result whole: a temporary file in the Nexus home, then one
 * rename, so a crash cannot leave half a result where a caller reads a whole
 * one. Gives the sentence of a failure, or undefined.
 */
function writeResult(paths: Paths, document: CheckResult): string | undefined {
  const temp = createTemp(paths.nexusHome);
  if (temp === undefined) {
    return `cannot create a temporary file in the Nexus home: ${paths.nexusHome}`;
  }
  try {
    try {
      writeSync(temp.fd, `${prettyJson(document)}\n`);
    } finally {
      closeSync(temp.fd);
    }
  } catch {
    rmSync(temp.path, { force: true });
    return `cannot write the check result: ${temp.path}`;
  }
  try {
    renameSync(temp.path, paths.checkResult);
  } catch {
    rmSync(temp.path, { force: true });
    return `cannot replace the check result: ${paths.checkResult}`;
  }
  return undefined;
}

/** A new file `<dir>/.nexus-tmp.check.XXXXXX`, private to its owner, as `mktemp` makes it. */
function createTemp(dir: string): { readonly path: string; readonly fd: number } | undefined {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = Array.from(randomBytes(6), (byte) => letters[byte % letters.length]).join('');
    const path = join(dir, TEMP_PREFIX + suffix);
    try {
      return { path, fd: openSync(path, 'wx', 0o600) };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
  }
  return undefined;
}

/**
 * Say a Check Result: the document with `--json`, else the table. A check
 * that just ran and `--last` both come here, so the two cannot drift apart.
 */
function answer(paths: Paths, document: Readonly<Record<string, unknown>>, json: boolean): void {
  if (json) {
    process.stdout.write(`${prettyJson(document)}\n`);
    return;
  }
  const skills = Array.isArray(document.skills) ? (document.skills as unknown[]) : [];
  const lines = ['name\tstate\tsource\tupdated\tupstream'];
  for (const skill of skills) {
    const cells = [
      field(skill, 'name'),
      field(skill, 'state'),
      orDash(field(skill, 'source')),
      orDash(field(skill, 'updatedAt')),
      orDash(field(skill, 'committedAt')),
    ];
    lines.push(cells.map(tsvCell).join('\t'));
  }
  for (const skill of skills) {
    if (field(skill, 'state') !== 'unknown') continue;
    const reason = interpolate(field(skill, 'reason'));
    lines.push(`unknown ${interpolate(field(skill, 'name'))}: ${reason}`);
  }
  const counts = document.counts;
  const count = (name: string) => interpolate(field(counts, name));
  lines.push(
    `checked at ${interpolate(document.checkedAt)}: ${count('current')} current, ` +
      `${count('behind')} behind, ${count('unknown')} unknown (${paths.checkResult})`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** One field of a value, as jq's `.name` reads it: null for anything not there. */
function field(value: unknown, name: string): unknown {
  return isObject(value) && Object.hasOwn(value, name) ? value[name] : null;
}

/** jq's `// "-"`: null and false are no value. */
function orDash(value: unknown): unknown {
  return value === null || value === false ? '-' : value;
}

/**
 * One cell as jq's `@tsv` writes it: a string with its tab, newline, return
 * and backslash escaped, and any other value as JSON.
 */
function tsvCell(value: unknown): string {
  if (value === null) return '';
  if (typeof value !== 'string') return compactJson(value);
  return value.replace(/[\\\t\n\r]/g, (c) => TSV_ESCAPES[c] ?? c);
}

/** A value inside a jq string interpolation: a string as it is, anything else as JSON. */
function interpolate(value: unknown): string {
  return typeof value === 'string' ? value : compactJson(value ?? null);
}

/**
 * One lock field as text, as jq's `join` gives it: a string as it is, a
 * number or `true` as its JSON, and no value as empty.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || value === true) return String(value);
  return '';
}

