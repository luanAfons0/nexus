/**
 * `nexus list [--json]`: every Installed, Custom and Control Skill, and the
 * state of the Global Instructions. It reads and never writes, apart from
 * the lock Snapshot it removes again.
 *
 * The output is the Bash CLI's byte for byte (`list_skills` in
 * `scripts/lib/list.sh`), because scripts and the Plugin Page read it: a
 * tab-separated table sorted by name, then one line for the Global
 * Instructions; or, with `--json`, one compact JSON object. A missing lock
 * is a notice, not a fault, and with `--json` the notice goes to stderr so
 * that stdout stays JSON.
 */
import { statSync } from 'node:fs';
import type { Command } from './cli.ts';
import { CONTROL_SKILLS } from './control-skills.ts';
import { customRootFault, globalInstructionsFault, readCustomSkills } from './custom.ts';
import { HELP_TEXT } from './help.ts';
import { globalInstructionsLine, readGlobalInstructions } from './instructions.ts';
import { compactJson } from './json.ts';
import { lockField, type NexusLock, readLock } from './lock.ts';
import { error, info, note } from './output.ts';
import { readPaths } from './paths.ts';
import { byteOrder } from './skill-names.ts';

/** One row of the list, before it is printed. */
type Row = {
  readonly name: string;
  readonly kind: 'installed' | 'custom' | 'control';
  readonly source: unknown;
  readonly hash: unknown;
  readonly updatedAt: unknown;
};

/** List the skills; exit 0, 1 on a fault, 2 on a usage refusal. */
export const list: Command = async (args) => {
  if (args.some((arg) => arg !== '--json')) {
    process.stderr.write(HELP_TEXT);
    return 2;
  }
  const json = args.length > 0;
  const paths = readPaths();

  let lock: NexusLock | undefined;
  if (isFile(paths.lock)) {
    const read = readLock(paths.lock, paths.nexusHome);
    if (!read.ok) {
      for (const sentence of read.errors) error(sentence);
      return 1;
    }
    lock = read.lock;
  } else if (json) {
    note(`lock is absent: ${paths.lock}`);
  } else {
    info(`lock is absent: ${paths.lock}`);
  }

  for (const fault of [customRootFault(paths), globalInstructionsFault(paths)]) {
    if (fault !== undefined) {
      error(fault);
      return 1;
    }
  }
  const custom = readCustomSkills(paths);
  if (custom.errors.length > 0) {
    for (const sentence of custom.errors) error(sentence);
    return 1;
  }

  const rows: Row[] = [
    ...(lock === undefined ? [] : lock.names.map((name) => installedRow(lock, name))),
    ...custom.names.map((name) => emptyRow(name, 'custom')),
    ...CONTROL_SKILLS.map((name) => emptyRow(name, 'control')),
  ];
  if (json) {
    // A stable sort by name keeps installed before custom for one name, as
    // jq's sort_by does.
    const skills = rows.toSorted((a, b) => byteOrder(a.name, b.name));
    const globalInstructions = readGlobalInstructions(paths, false);
    process.stdout.write(`${compactJson({ skills, globalInstructions })}\n`);
    return 0;
  }
  const lines = rows.map(tableLine).sort(byTableKey);
  const header = 'name\tkind\tsource\thash\tupdated';
  process.stdout.write([header, ...lines, globalInstructionsLine(paths)].join('\n') + '\n');
  return 0;
};

/** The row of one Installed Skill: `null` and `false` fields are null. */
function installedRow(lock: NexusLock, name: string): Row {
  return {
    name,
    kind: 'installed',
    source: lockField(lock, name, 'source') ?? null,
    hash: lockField(lock, name, 'skillFolderHash') ?? null,
    updatedAt: lockField(lock, name, 'updatedAt') ?? null,
  };
}

/** The row of a Custom or Control Skill, which carries no upstream version. */
function emptyRow(name: string, kind: 'custom' | 'control'): Row {
  return { name, kind, source: null, hash: null, updatedAt: null };
}

/** One table line: the hash cut to 8 characters, and `-` for no value. */
function tableLine(row: Row): string {
  const hash = cell(row.hash);
  const short = hash === '-' ? hash : Array.from(hash).slice(0, 8).join('');
  return [row.name, row.kind, cell(row.source), short, cell(row.updatedAt)].join('\t');
}

/**
 * One cell as `jq -r` and a command substitution leave it: a string as it
 * is with its trailing newlines cut, any other value as JSON, and `-` for no
 * value or an empty one.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined || value === false) return '-';
  const text = typeof value === 'string' ? value.replace(/\n+$/, '') : compactJson(value);
  return text === '' ? '-' : text;
}

/** The order of `LC_ALL=C sort -t TAB -k1,1`: by name, then by the whole line. */
function byTableKey(a: string, b: string): number {
  return byteOrder(a.split('\t')[0] ?? '', b.split('\t')[0] ?? '') || byteOrder(a, b);
}

/** True when `path` is a file, following a symlink (`-f`). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
