/**
 * The Nexus Lock: read it once, as a Snapshot, and accept it only as an exact
 * version-3 lock (ADR 0001).
 *
 * The lock is authoritative for which Installed Skills exist, so a lock Nexus
 * cannot fully trust is refused whole: one JSON object, a `version` that is
 * the number 3, a `skills` object, and every key a safe Skill Name that is no
 * Control Skill's. Its format does not change in the port.
 *
 * The file is copied into a Snapshot directory, `<Nexus home>/.nexus-lock.*`,
 * and only the copy is read, exactly once; the directory is removed after. A
 * lock replaced while Nexus reads it cannot change what Nexus does with it.
 * The sentences are the Bash CLI's (`load_validated_lock_names` in
 * `scripts/lib/lock.sh`).
 */
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isControlSkill } from './control-skills.ts';
import { fault, pause, paused, seamFailure } from './fault.ts';
import { sortedJson } from './json.ts';
import { byteOrder, isSafeSkillName } from './skill-names.ts';

/** A lock that passed every rule. */
export type NexusLock = {
  /** Every Skill Name in it, in byte order (the order of `jq keys`). */
  readonly names: readonly string[];
  /** The whole document, as parsed from the Snapshot. */
  readonly document: Readonly<Record<string, unknown>>;
  /** The bytes of the Snapshot that was validated. */
  readonly bytes: Buffer;
};

/** What reading a lock gave: the lock, or the sentences that refuse it. */
export type LockRead =
  | { readonly ok: true; readonly lock: NexusLock }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Told when a Snapshot directory is made and when it is gone, so that Setup
 * can name it as Residue if a signal stops Nexus in between.
 */
export type SnapshotWatch = {
  /** A Snapshot directory now exists at `dir`. */
  readonly held: (dir: string) => void;
  /** The Snapshot directory at `dir` is gone. */
  readonly released: (dir: string) => void;
};

/** The prefix of a Snapshot directory's name in the Nexus home. */
export const SNAPSHOT_PREFIX = '.nexus-lock.';

/** The prefix of the directory that holds Setup's candidate Snapshots. */
export const CANDIDATES_PREFIX = '.nexus-lock-candidates.';

/** What Setup's lock discovery gave. */
export type Discovery =
  | {
      readonly ok: true;
      /** The candidate Setup Publishes from, as the sentences name it. */
      readonly selected: string;
      /** Its Snapshot, the file Setup validates again and Publishes. */
      readonly snapshot: string;
      /** The directory of every candidate's Snapshot. */
      readonly dir: string;
    }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
      /** The directory of the candidates' Snapshots, when one was made. */
      readonly dir?: string;
    };

/**
 * Read the lock at `file` through a Snapshot in `nexusHome`, and validate it.
 * `file` is the path the sentences name: the Nexus Lock, or an Upstream Lock
 * Snapshot that Install or Setup validates before it Publishes.
 */
export function readLock(file: string, nexusHome: string, watch?: SnapshotWatch): LockRead {
  if (fault('lock_extract')) return refused('test seam: lock key extraction failed');
  if (!isRegularFile(file)) {
    return refused(`invalid version-3 lock: expected regular file at ${file}`);
  }
  let dir: string;
  try {
    dir = mkdtempSync(join(nexusHome, SNAPSHOT_PREFIX));
  } catch {
    return refused(`cannot create lock snapshot directory under ${nexusHome}`);
  }
  watch?.held(dir);
  if (watch !== undefined && fault('term_pre', 'term_pre_cleanup_fail')) pause('pre');
  const post = watch !== undefined && fault('term_post', 'term_post_cleanup_fail');
  if (post && isPresent(join(nexusHome, 'skill-lock.json'))) pause('post');
  const errors: string[] = [];
  const snapshot = join(dir, 'lock.json');
  let lock: NexusLock | undefined;
  try {
    copyFileSync(file, snapshot);
    const bytes = readFileSync(snapshot);
    lock = validate(bytes);
    if (lock === undefined) {
      errors.push(
        `invalid version-3 lock: ${file} must be one JSON object with numeric version 3, ` +
          'object skills, and safe skill names',
      );
    }
  } catch {
    errors.push(`cannot snapshot lock file: ${file}`);
  }
  const cleanup = removeSnapshot(dir, nexusHome);
  if (cleanup === undefined) watch?.released(dir);
  else errors.push(cleanup);
  if (lock === undefined || errors.length > 0) return { ok: false, errors };
  if (fault('lock_replace')) writeFileSync(file, '{"version":3,"skills":{"../escape":{}}}\n');
  return { ok: true, lock };
}

/** One skill's entry in the lock, as parsed; undefined when it has none. */
export function lockEntry(lock: NexusLock, name: string): unknown {
  const skills = lock.document.skills as Readonly<Record<string, unknown>>;
  return Object.hasOwn(skills, name) ? skills[name] : undefined;
}

/**
 * One field of one skill's entry, read as `jq '.skills[$n][$f] // empty'`
 * reads it: absent, `null` and `false` all mean no value, and so does an
 * entry that is not an object.
 */
export function lockField(lock: NexusLock, name: string, field: string): unknown {
  const entry = lockEntry(lock, name);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  if (!Object.hasOwn(entry, field)) return undefined;
  const value = (entry as Readonly<Record<string, unknown>>)[field];
  return value === null || value === false ? undefined : value;
}

/**
 * The lock as one line with sorted keys, as `jq -S -c` writes it. Two locks
 * that give the same line say the same thing, however their text is laid out.
 */
export function semanticLockJson(lock: NexusLock): string {
  return sortedJson(lock.document);
}

/**
 * Setup's search for the Upstream Lock it Publishes from. Each candidate
 * that exists is copied once into a Snapshot under
 * `<Nexus home>/.nexus-lock-candidates.*` and only the copy is read, so a
 * lock that changes after discovery cannot change what Setup Publishes.
 * Every candidate must be a valid version-3 lock, and every valid one must
 * say the same thing (the same `jq -S -c`); the first is selected. The
 * sentences and their order are the Bash CLI's (`discover_lock`). `watch`
 * is told of the candidates' directory and of each validation Snapshot.
 */
export function discoverLock(home: string, nexusHome: string, watch?: SnapshotWatch): Discovery {
  const candidates = [
    join(home, '.agents', '.skill-lock.json'),
    join(home, '.agents', 'skill-lock.json'),
    join(home, '.skills', '.skill-lock.json'),
    join(home, '.skills', 'skill-lock.json'),
  ];
  let dir: string;
  try {
    dir = mkdtempSync(join(nexusHome, CANDIDATES_PREFIX));
  } catch {
    return { ok: false, errors: ['cannot reserve candidate lock snapshots'] };
  }
  watch?.held(dir);
  const errors: string[] = [];
  const invalid: string[] = [];
  const valid: { readonly candidate: string; readonly snapshot: string; readonly json: string }[] =
    [];
  let found = 0;
  for (const candidate of candidates) {
    if (!isPresent(candidate)) continue;
    found += 1;
    const snapshot = join(dir, `${found}.json`);
    if (!snapshotCandidate(candidate, snapshot)) {
      errors.push(`cannot snapshot setup lock candidate: ${candidate}`);
      invalid.push(candidate);
      continue;
    }
    const read = readLock(snapshot, nexusHome, watch);
    if (!read.ok) {
      errors.push(...read.errors);
      invalid.push(candidate);
      continue;
    }
    valid.push({ candidate, snapshot, json: semanticLockJson(read.lock) });
  }
  if (invalid.length > 0) {
    errors.push(`invalid setup lock candidates: ${invalid.join(' ')}`);
    return { ok: false, errors, dir };
  }
  const [first] = valid;
  if (first === undefined) {
    errors.push(`no version-3 skill lock found (checked: ${candidates.join(' ')})`);
    return { ok: false, errors, dir };
  }
  if (valid.some((each) => each.json !== first.json)) {
    const names = valid.map((each) => each.candidate).join(' ');
    errors.push(`conflicting setup lock candidates: ${names}`);
    return { ok: false, errors, dir };
  }
  return { ok: true, selected: first.candidate, snapshot: first.snapshot, dir };
}

/**
 * Remove the candidates' Snapshots that `discoverLock` made in `dir`. Silent
 * when `dir` is no such directory; the sentence that names it when it stays.
 */
export function cleanupDiscoveredLockSnapshots(
  dir: string,
  nexusHome: string,
): string | undefined {
  if (
    !isDirectory(dir) ||
    resolve(dirname(dir)) !== resolve(nexusHome) ||
    !basename(dir).startsWith(CANDIDATES_PREFIX)
  ) {
    return undefined;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  } catch {
    return `candidate lock snapshots retained: ${dir}`;
  }
}

/** Copy one candidate, following a symlink as `cp` does, and check the copy's bytes. */
function snapshotCandidate(candidate: string, snapshot: string): boolean {
  try {
    copyFileSync(candidate, snapshot);
    return readFileSync(candidate).equals(readFileSync(snapshot));
  } catch {
    return false;
  }
}

/** True when anything is at `path`, a dangling symlink too (`-e` or `-L`). */
function isPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` is a directory, following a symlink (`-d`). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The lock in `bytes` when it passes every rule, else undefined. */
function validate(bytes: Buffer): NexusLock | undefined {
  // jq skips a leading byte order mark; JSON.parse does not.
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(document)) return undefined;
  if (typeof document.version !== 'number' || document.version !== 3) return undefined;
  if (!isObject(document.skills)) return undefined;
  const names = Object.keys(document.skills);
  if (!names.every((name) => isSafeSkillName(name) && !isControlSkill(name))) return undefined;
  return { names: names.sort(byteOrder), document, bytes };
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for a regular file that is not a symlink (`-f` and not `-L`). */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Remove a Snapshot directory; the sentence that says why not, or undefined. */
function removeSnapshot(dir: string, nexusHome: string): string | undefined {
  if (resolve(dirname(dir)) !== resolve(nexusHome) || !basename(dir).startsWith(SNAPSHOT_PREFIX)) {
    return `invalid lock snapshot directory: ${dir}`;
  }
  try {
    const seam = fault('term_pre_cleanup_fail', 'term_post_cleanup_fail') && paused();
    if (seam) seamFailure('lock snapshot cleanup failed');
    else rmSync(join(dir, 'lock.json'), { force: true });
    rmdirSync(dir);
    return undefined;
  } catch {
    return `cannot clean lock snapshot directory: ${dir}`;
  }
}

function refused(sentence: string): LockRead {
  return { ok: false, errors: [sentence] };
}
