/**
 * `nexus setup`: the one-time move of an existing Agent Context under
 * Nexus. It discovers the Upstream Lock, takes the Backup of both Agent
 * Homes, Publishes the first Nexus Lock, makes the Canonical Root own its
 * skills, and links. Once a Nexus Lock exists, Setup is disabled and says
 * to run Link instead.
 *
 * Every Preflight runs before any change: an existing Backup, the lock
 * candidates, the Canonical Root. Nothing an agent reads changes before the
 * Backup is verified and promoted, and the Nexus Lock is Published only from
 * the validated Snapshot, through a no-clobber copy that is checked before
 * and after (ADR 0001). A failure after publication keeps the lock and both
 * Backups and says how to finish with Link. One Setup runs at a time: the
 * mutex `<Nexus home>/.nexus-setup.lock` refuses a second one, and stays,
 * naming itself, when it cannot be released.
 *
 * Every temp Setup makes is registered as Residue (`residue.ts`). When Setup
 * ends, each one is removed or named. A signal is seen at each checkpoint
 * between steps; it stops Setup, removes what is Setup's own, names every
 * path a person must review before a retry, and exits 130 (INT) or 143
 * (TERM), as the Bash CLI's traps did.
 *
 * The sentences, their order and the exit codes are the Bash CLI's
 * (`setup` in `scripts/lib/setup.sh`).
 */
import { randomInt } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { backupTransaction, TRANSACTION_PREFIX } from './backup.ts';
import {
  CANONICAL_TEMP_PREFIX,
  canonicalRootFault,
  materializeCanonicalLinks,
} from './canonical.ts';
import type { Command } from './cli.ts';
import { CONTROL_SKILLS } from './control-skills.ts';
import { unsupportedSystem } from './link-primitive.ts';
import { linkAll } from './link.ts';
import {
  CANDIDATES_PREFIX,
  cleanupDiscoveredLockSnapshots,
  discoverLock,
  readLock,
  SNAPSHOT_PREFIX,
  type SnapshotWatch,
} from './lock.ts';
import { error, info } from './output.ts';
import { type Paths, readPaths } from './paths.ts';
import {
  type Checkpoint,
  isPhysicalDirectory,
  isPresent,
  newResidue,
  removeOwnedFile,
  removeTree,
  type Residue,
} from './residue.ts';

/** The prefix of the staged copy of the Nexus Lock, beside it. */
const COPY_PREFIX = '.nexus-setup-copy.';

/** The prefix of a selected lock Snapshot in the Nexus home (Bash `snapshot_setup_lock`). */
const SOURCE_PREFIX = '.nexus-setup-source.';

/** The sentence of a Setup that finds a Nexus Lock: Link is the way on. */
const ALREADY_INITIALIZED = 'already initialized; run /nexus-link or $nexus-link to reconcile skills';

/** A signal that stopped Setup, carried out to the code that cleans up. */
type Interruption = { readonly interruption: true; readonly signal: 'SIGINT' | 'SIGTERM' };

/** One run of Setup: its paths, its Residue, and what it has made so far. */
type SetupRun = {
  readonly paths: Paths;
  readonly residue: Residue;
  /** The mutex directory, while this run holds it. */
  mutex: string | undefined;
  /** The directory of the lock candidates' Snapshots, once made. */
  discoveryDir: string | undefined;
  /** Both Backups, once promoted. */
  backups: { readonly claude: string; readonly codex: string } | undefined;
};

/** `nexus setup`. */
export const setup: Command = async () => runSetup(readPaths());

async function runSetup(paths: Paths): Promise<number> {
  if (isPresent(paths.lock)) {
    info(ALREADY_INITIALIZED);
    return 0;
  }
  const unsupported = unsupportedSystem('setup');
  if (unsupported !== undefined) {
    error(unsupported);
    return 1;
  }
  const mutex = join(paths.nexusHome, '.nexus-setup.lock');
  try {
    mkdirSync(mutex);
  } catch {
    error(`another setup is already running or recovery is required: ${mutex}`);
    return 1;
  }
  if (!isPhysicalDirectory(mutex)) {
    error(`invalid setup lock directory: ${mutex}`);
    return 1;
  }
  const run: SetupRun = {
    paths,
    residue: newResidue(),
    mutex,
    discoveryDir: undefined,
    backups: undefined,
  };
  const signals = listenForSignals();
  try {
    let status: number;
    try {
      status = await setupInner(run, signals.checkpoint);
    } catch (failure) {
      if (isInterruption(failure)) return interrupted(run, failure.signal);
      failedUnexpectedly(run);
      throw failure;
    }
    try {
      return await finalize(run, status, signals.checkpoint);
    } catch (failure) {
      if (isInterruption(failure)) return interrupted(run, failure.signal);
      throw failure;
    }
  } finally {
    signals.stop();
  }
}

/** Setup's steps, from the Preflight to the summary (`setup_inner`). */
async function setupInner(run: SetupRun, checkpoint: Checkpoint): Promise<number> {
  const { paths, residue } = run;
  if (isPresent(paths.lock)) {
    info(ALREADY_INITIALIZED);
    return 0;
  }
  if (!backupPreflight(paths)) return 1;
  const watch: SnapshotWatch = { held: residue.temp, released: residue.forget };
  const discovery = discoverLock(paths.home, paths.nexusHome, watch);
  run.discoveryDir = discovery.dir;
  if (!discovery.ok) {
    for (const sentence of discovery.errors) error(sentence);
    return 1;
  }
  await checkpoint();
  const rootFault = canonicalRootFault(paths);
  if (rootFault !== undefined) {
    error(rootFault);
    return 1;
  }
  const selected = readLock(discovery.snapshot, paths.nexusHome, watch);
  if (!selected.ok) {
    for (const sentence of selected.errors) error(sentence);
    return 1;
  }
  await checkpoint();

  const backup = await backupTransaction(paths.home, residue, checkpoint);
  if (!backup.ok) return 1;
  run.backups = { claude: backup.claude, codex: backup.codex };
  await checkpoint();

  if (!publishSetupLock(run, discovery.snapshot)) {
    if (isPresent(paths.lock)) {
      postPublicationFailure(run, 'Nexus lock publication verification failed');
    } else {
      error(`backups retained at: ${backup.claude} and ${backup.codex}`);
    }
    return 1;
  }
  await checkpoint();

  const names = selected.lock.names;
  let settled = await materializeCanonicalLinks(paths, names, residue, checkpoint);
  if (settled) settled = linkAll(paths, true) === 0;
  if (settled) {
    await checkpoint();
    settled = await materializeCanonicalLinks(paths, names, residue, checkpoint);
  }
  if (!settled) {
    postPublicationFailure(run, 'setup encountered a post-publication failure');
    return 1;
  }
  const entries = (names.length + CONTROL_SKILLS.length) * 2;
  info(
    `setup complete: source lock: ${discovery.selected}; Claude backup: ${backup.claude}; ` +
      `Codex backup: ${backup.codex}; third-party skills: ${names.length}; ` +
      `linked agent skill entries: ${entries} (two agents; includes ` +
      `${CONTROL_SKILLS.length} controls)`,
  );
  return 0;
}

/** Refuse Setup when either Backup already exists, naming each (`setup_backup_preflight`). */
function backupPreflight(paths: Paths): boolean {
  let ok = true;
  for (const backup of [join(paths.home, '.claude-backup'), join(paths.home, '.codex-backup')]) {
    if (isPresent(backup)) {
      error(`backup already exists: ${backup}`);
      ok = false;
    }
  }
  return ok;
}

/** Publish the first Nexus Lock from the validated Snapshot `source` (`publish_setup_lock`). */
function publishSetupLock(run: SetupRun, source: string): boolean {
  const { paths } = run;
  if (isPresent(paths.lock)) {
    error(`Nexus lock already exists: ${paths.lock}`);
    return false;
  }
  try {
    mkdirSync(paths.nexusHome, { recursive: true });
  } catch {
    error(`cannot create Nexus home: ${paths.nexusHome}`);
    return false;
  }
  if (!atomicCopy(run.residue, source, paths.lock)) {
    error('cannot publish Nexus lock');
    return false;
  }
  return true;
}

/**
 * Copy `source` to `destination`, which must be free, through a temp beside
 * it: check the temp's bytes, put it in place without replacing anything,
 * and check the bytes again (`atomic_copy`).
 */
function atomicCopy(residue: Residue, source: string, destination: string): boolean {
  const parent = dirname(destination);
  if (isPresent(destination)) {
    error(`destination already exists: ${destination}`);
    return false;
  }
  const temp = reserveFile(parent, COPY_PREFIX);
  if (temp === undefined) {
    error(`cannot reserve atomic copy destination for ${destination}`);
    return false;
  }
  residue.temp(temp);
  const discard = (): void => {
    removeOwnedFile(residue, temp, parent, COPY_PREFIX);
  };
  try {
    writeFileSync(temp, readFileSync(source));
  } catch {
    discard();
    error(`cannot copy source: ${source}`);
    return false;
  }
  if (!sameBytes(source, temp)) {
    discard();
    error(`atomic copy staging verification failed: ${destination}`);
    return false;
  }
  if (!moveFileOntoNothing(temp, destination) || isPresent(temp)) {
    discard();
    error(`cannot promote copied file: ${destination}`);
    return false;
  }
  residue.forget(temp);
  if (!sameBytes(source, destination)) {
    error(`atomic copy post-publication verification failed: ${destination}`);
    return false;
  }
  return true;
}

/**
 * Put the file `source` at `destination` only if nothing is there (`mv -Tn`).
 * A hard link refuses an existing name in one step; where the file system
 * has none, a check and a rename do it.
 */
function moveFileOntoNothing(source: string, destination: string): boolean {
  try {
    linkSync(source, destination);
  } catch (failure) {
    if ((failure as { code?: unknown }).code === 'EEXIST' || isPresent(destination)) return false;
    try {
      renameSync(source, destination);
      return true;
    } catch {
      return false;
    }
  }
  try {
    unlinkSync(source);
  } catch {
    // The name stays; the caller sees it and cleans it up.
  }
  return true;
}

/**
 * Make an empty file `<parent>/<prefix>XXXXXX`, readable by its owner only,
 * as `mktemp` does. Undefined when none could be made.
 */
function reserveFile(parent: string, prefix: string): string | undefined {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let tries = 0; tries < 100; tries += 1) {
    let suffix = '';
    for (let i = 0; i < 6; i += 1) suffix += letters[randomInt(letters.length)];
    const path = join(parent, `${prefix}${suffix}`);
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return path;
    } catch (failure) {
      if ((failure as { code?: unknown }).code !== 'EEXIST') return undefined;
    }
  }
  return undefined;
}

/** True when both files hold the same bytes; false when either cannot be read. */
function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** Say that the lock and both Backups stay, and how to finish with Link. */
function postPublicationFailure(run: SetupRun, detail: string): void {
  const { paths } = run;
  error(detail);
  error(
    `setup is now initialized/disabled; retained Nexus lock: ${paths.lock}; ` +
      `retained backups: ${run.backups?.claude ?? ''} and ${run.backups?.codex ?? ''}`,
  );
  error(linkAdvice(paths));
}

/** The sentence that sends a person to Link. */
function linkAdvice(paths: Paths): string {
  return (
    'correct the reported issue, then run /nexus-link or $nexus-link ' +
    `(CLI: ${paths.nexusHome}/scripts/nexus link)`
  );
}

/**
 * Setup's end on every path that was not stopped by a signal: remove the
 * candidates' Snapshots and every temp, name what stays, and release the
 * mutex. Any of these that fails makes the exit code 1.
 */
async function finalize(run: SetupRun, status: number, checkpoint: Checkpoint): Promise<number> {
  let result = status;
  await checkpoint();
  if (!cleanupDiscovered(run)) result = 1;
  await checkpoint();
  if (!cleanupOwnedTemps(run)) {
    reportRetainedTemps(run);
    result = 1;
  }
  if (!releaseMutex(run)) result = 1;
  return result;
}

/**
 * A signal stopped Setup (`setup_signal_handler`): clean what is Setup's own,
 * name what stays, release the mutex, and give the signal's exit code.
 */
function interrupted(run: SetupRun, signal: 'SIGINT' | 'SIGTERM'): number {
  const { paths } = run;
  cleanupDiscovered(run);
  cleanupOwnedTemps(run);
  reportRetainedTemps(run);
  if (hasPublished(paths)) {
    error(`setup interrupted; retained final/recovery paths: ${finalPaths(paths)}`);
    reportRecoveries(run);
    error(
      'rerun setup only after reviewing retained paths; correct the issue, then run ' +
        `/nexus-link or $nexus-link (CLI: ${paths.nexusHome}/scripts/nexus link)`,
    );
  } else {
    error(
      'setup interrupted before publication; no final backups or Nexus lock were published; ' +
        'rerun setup',
    );
  }
  releaseMutex(run);
  return signal === 'SIGINT' ? 130 : 143;
}

/**
 * Setup stopped on a fault in Nexus itself (`setup_exit_handler`): clean and
 * name as on a failure, so that the fault does not hide the Residue.
 */
function failedUnexpectedly(run: SetupRun): void {
  const { paths } = run;
  cleanupDiscovered(run);
  cleanupOwnedTemps(run);
  reportRetainedTemps(run);
  if (hasPublished(paths)) {
    error(`setup failed; retained final/recovery paths: ${finalPaths(paths)}`);
    reportRecoveries(run);
  }
  releaseMutex(run);
}

/** True when a Backup or the Nexus Lock exists: Setup got as far as a final path. */
function hasPublished(paths: Paths): boolean {
  return (
    exists(join(paths.home, '.claude-backup')) ||
    exists(join(paths.home, '.codex-backup')) ||
    isPresent(paths.lock)
  );
}

function finalPaths(paths: Paths): string {
  return [join(paths.home, '.claude-backup'), join(paths.home, '.codex-backup'), paths.lock].join(
    ' ',
  );
}

function reportRecoveries(run: SetupRun): void {
  const recoveries = run.residue.recoveries();
  if (recoveries.length > 0) error(`retained setup recovery paths: ${recoveries.join(' ')}`);
}

/** Remove the candidates' Snapshots; false, after its sentence, when they stay. */
function cleanupDiscovered(run: SetupRun): boolean {
  const dir = run.discoveryDir;
  if (dir === undefined) return true;
  const retained = cleanupDiscoveredLockSnapshots(dir, run.paths.nexusHome);
  if (retained !== undefined) {
    error(retained);
    return false;
  }
  run.residue.forget(dir);
  run.discoveryDir = undefined;
  return true;
}

/**
 * Remove every registered temp that sits where Setup makes its temps
 * (`setup_cleanup_owned_temps`). A temp elsewhere is never removed. False
 * when any is left; it stays registered, to be named.
 */
function cleanupOwnedTemps(run: SetupRun): boolean {
  const { paths, residue } = run;
  const owners: readonly (readonly [string, string])[] = [
    [paths.home, TRANSACTION_PREFIX],
    [paths.canonicalRoot, CANONICAL_TEMP_PREFIX],
    [paths.nexusHome, SOURCE_PREFIX],
    [paths.nexusHome, COPY_PREFIX],
    [paths.nexusHome, SNAPSHOT_PREFIX],
    [paths.nexusHome, CANDIDATES_PREFIX],
  ];
  let clean = true;
  for (const path of residue.temps()) {
    const owned = owners.some(([parent, prefix]) => path.startsWith(join(parent, prefix)));
    if (!isPresent(path) || (owned && removeTree(path))) {
      residue.forget(path);
    } else {
      clean = false;
    }
  }
  return clean;
}

function reportRetainedTemps(run: SetupRun): void {
  const temps = run.residue.temps();
  if (temps.length > 0) error(`retained setup temp paths: ${temps.join(' ')}`);
}

/** Remove the mutex; false, after its sentence, when it stays (`setup_lock_release`). */
function releaseMutex(run: SetupRun): boolean {
  const mutex = run.mutex;
  if (mutex === undefined || !isPhysicalDirectory(mutex)) return true;
  try {
    rmdirSync(mutex);
  } catch {
    error(`setup lock retained for recovery: ${mutex}`);
    return false;
  }
  run.mutex = undefined;
  return true;
}

/** INT and TERM, held while Setup runs, and seen at each checkpoint. */
function listenForSignals(): { readonly checkpoint: Checkpoint; readonly stop: () => void } {
  let pending: 'SIGINT' | 'SIGTERM' | undefined;
  const onInt = (): void => {
    pending ??= 'SIGINT';
  };
  const onTerm = (): void => {
    pending ??= 'SIGTERM';
  };
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return {
    checkpoint: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (pending !== undefined) throw interruption(pending);
    },
    stop: () => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    },
  };
}

function interruption(signal: 'SIGINT' | 'SIGTERM'): Interruption {
  return { interruption: true, signal };
}

function isInterruption(value: unknown): value is Interruption {
  return (value as Partial<Interruption> | null)?.interruption === true;
}

/** True when `path` exists, following a symlink (`-e`). */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
