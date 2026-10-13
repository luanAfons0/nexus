/**
 * The Backup: Setup's copy of each Agent Home, `~/.claude` and `~/.codex`,
 * to `~/.claude-backup` and `~/.codex-backup`, taken before Setup changes
 * anything an agent reads.
 *
 * The Backup is the safety contract of Setup, so it keeps every guarantee of
 * the Bash CLI (`backup_transaction` in `scripts/lib/setup.sh`):
 * - it is a copy, never a move: the Agent Home is left as it was;
 * - it never overwrites: an existing Backup refuses Setup, and each
 *   promotion is a rename onto nothing;
 * - it is verified: a manifest of the source before the copy, of the copy,
 *   and of the source after must agree, or the copy is refused;
 * - a source that changed during the copy is copied once more, and a second
 *   change refuses Setup and asks a person to close the agents;
 * - both copies are made in one transaction directory beside the home and
 *   promoted together: if the second promotion fails, the first is taken
 *   back, and if that fails too, every path is named for recovery;
 * - each promoted root must still be the tree that was verified: the same
 *   device, inode and type (`identity.ts`).
 */
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Manifest, readManifest, sameManifest } from './backup-manifest.ts';
import { fault, homeFile, seamFailure, tryChange } from './fault.ts';
import { entryIdentity } from './identity.ts';
import { error } from './output.ts';
import {
  type Checkpoint,
  isOwnedDir,
  isPhysicalDirectory,
  isPresent,
  removeOwnedDir,
  removeTree,
  type Residue,
} from './residue.ts';
import { COPY_TIME_UNIT, copyTree } from './tree-copy.ts';

/** The prefix of the transaction directory, in the home directory. */
export const TRANSACTION_PREFIX = '.nexus-setup-backup.';

/** What the Backup gave: both Backups, or a refusal already said. */
export type BackupResult =
  | { readonly ok: true; readonly claude: string; readonly codex: string }
  | { readonly ok: false };

/** A time the fault points write: `2026-01-01 00:00:00.987654321`, local, as `touch -d`. */
const LATE = new Date(2026, 0, 1).getTime() / 1000 + 0.987654321;

/** A whole second the fault points write: 2026-01-01T00:00:00Z. */
const WHOLE_SECOND = Date.UTC(2026, 0, 1) / 1000;

/** How one attempt at one Agent Home ended. */
type Verdict = 'verified' | 'failed' | 'changed';

/**
 * Take the Backup of both Agent Homes under `home`. Every refusal is said
 * here; the transaction directory is registered in `residue` while it lives.
 */
export async function backupTransaction(
  home: string,
  residue: Residue,
  checkpoint: Checkpoint,
): Promise<BackupResult> {
  const claudeBackup = join(home, '.claude-backup');
  const codexBackup = join(home, '.codex-backup');
  for (const backup of [claudeBackup, codexBackup]) {
    if (isPresent(backup)) {
      error(`backup already exists: ${backup}`);
      return { ok: false };
    }
  }
  let tx: string;
  try {
    tx = mkdtempSync(join(home, TRANSACTION_PREFIX));
  } catch {
    error('cannot reserve setup backup transaction');
    return { ok: false };
  }
  if (!isOwnedDir(tx, home, TRANSACTION_PREFIX)) {
    error(`invalid setup backup transaction: ${tx}`);
    return { ok: false };
  }
  residue.temp(tx);
  const abandon = (): { readonly ok: false } => {
    if (removeOwnedDir(tx, home, TRANSACTION_PREFIX)) residue.forget(tx);
    return { ok: false };
  };

  const claudeTmp = join(tx, 'claude-backup');
  const codexTmp = join(tx, 'codex-backup');
  for (const attempt of [1, 2]) {
    if (attempt === 2) {
      removeTree(claudeTmp);
      removeTree(codexTmp);
    }
    let verdict = verifyBackupAttempt(join(home, '.claude'), claudeTmp, attempt);
    await checkpoint();
    if (verdict === 'verified') {
      verdict = verifyBackupAttempt(join(home, '.codex'), codexTmp, attempt);
      await checkpoint();
    }
    if (verdict === 'verified') break;
    if (verdict === 'failed') {
      error('cannot create complete agent backups');
      return abandon();
    }
    if (attempt === 2) {
      error('agent state changed during backup; close Claude and Codex and retry');
      return abandon();
    }
  }

  const claudeIdentity = verifiedIdentity(claudeTmp);
  const codexIdentity = verifiedIdentity(codexTmp);
  if (claudeIdentity === undefined || codexIdentity === undefined) return { ok: false };
  if (!backupMove(claudeTmp, claudeBackup)) {
    error('cannot promote Claude backup');
    return abandon();
  }
  if (!backupMove(codexTmp, codexBackup)) {
    error('cannot promote Codex backup');
    if (!backupMove(claudeBackup, claudeTmp)) {
      residue.forget(tx);
      residue.recovery(tx);
      error(`backup recovery retained: ${claudeBackup}; ${tx} (Codex backup: ${codexTmp})`);
      return { ok: false };
    }
    return abandon();
  }
  if (isPresent(claudeTmp)) {
    error('Claude backup promotion did not consume verified tree');
    return { ok: false };
  }
  if (isPresent(codexTmp)) {
    error('Codex backup promotion did not consume verified tree');
    return { ok: false };
  }
  if (
    entryIdentity(claudeBackup, false) !== claudeIdentity ||
    entryIdentity(codexBackup, false) !== codexIdentity
  ) {
    error('backup promotion changed verified tree identity');
    return { ok: false };
  }
  try {
    rmdirSync(tx);
  } catch {
    error(`setup backup transaction retained: ${tx}`);
    return { ok: false };
  }
  residue.forget(tx);
  return { ok: true, claude: claudeBackup, codex: codexBackup };
}

/**
 * Copy one Agent Home and check the copy (`verify_backup_attempt`):
 * `failed` when a manifest or the copy could not be made, `changed` when
 * the copy differs from the source or the source changed meanwhile.
 */
function verifyBackupAttempt(source: string, copied: string, attempt: number): Verdict {
  const before = backupManifest(source, true);
  if (before === undefined) return 'failed';
  if (!copyAgentTree(source, copied, attempt)) return 'failed';
  const copy = backupManifest(copied, true);
  if (copy === undefined) return 'failed';
  const absent = !isPresent(source);
  if (absent) {
    // An absent root is an empty Backup: the copy must be one empty directory.
    if (!isPhysicalDirectory(copied) || !isEmptyDirectory(copied)) return 'changed';
  } else if (!sameManifest(before, copy, { digests: true, timeUnit: COPY_TIME_UNIT })) {
    // The full manifest holds every field of the state one, so this one
    // comparison is the Bash CLI's two (`.full` and `.state`).
    error(`backup verification failed for ${source}`);
    return 'changed';
  }
  const after = backupManifest(source, false);
  if (after === undefined) return 'failed';
  if (!sameManifest(before, after, { digests: false, timeUnit: 1n })) {
    error(`backup verification failed for ${source}`);
    return 'changed';
  }
  return 'verified';
}

/** The manifest of `root`, or undefined after its sentence is said. */
function backupManifest(root: string, digests: boolean): Manifest | undefined {
  if (fault('backup_manifest_count')) {
    appendFileSync(homeFile('manifest-calls'), `${root}|${digests ? 'full' : 'state'}\n`);
  }
  const read = readManifest(root, digests);
  if (read.ok) return read.manifest;
  process.stderr.write(`backup manifest: ${read.error}\n`);
  return undefined;
}

/**
 * Copy the Agent Home `source` into `destination` (`copy_agent_tree`), on
 * the Backup's attempt `attempt` (Bash `BACKUP_ATTEMPT`). The fault points
 * fail the copy, corrupt it, or change the source while it is copied.
 */
function copyAgentTree(source: string, destination: string, attempt: number): boolean {
  const claude = basename(source) === '.claude';
  const first = claude && attempt === 1;
  const payload = join(source, 'payload');
  if (fault('backup_copy_fail') && claude) return seamFailure('backup copy failed');
  if (fault('backup_copy_false')) return makeDirectory(destination);
  if (fault('backup_source_content') && first) {
    writeFileSync(payload, 'changed');
    utimesSync(payload, WHOLE_SECOND, WHOLE_SECOND);
  }
  if (!copyHome(source, destination)) return false;
  if (fault('backup_copy_corrupt')) writeFileSync(join(destination, 'corrupt'), 'corrupt');
  if (fault('backup_root_corrupt') && claude) {
    chmodSync(destination, 0o700);
    utimesSync(destination, LATE, LATE);
  }
  if (fault('backup_child_corrupt') && claude) {
    appendFileSync(join(destination, 'child'), ''); // `touch` makes a missing file.
    utimesSync(join(destination, 'child'), LATE, LATE);
  }
  if (fault('backup_symlink_corrupt') && claude) {
    tryChange(() => unlinkSync(join(destination, 'trailing-newline-link')));
    symlinkSync('literal-target', join(destination, 'trailing-newline-link'));
  }
  if (fault('backup_retry_once') && first) {
    appendFileSync(join(source, 'retry-marker'), 'retry-state\n');
  }
  if (fault('backup_retry_always') && claude) {
    appendFileSync(join(source, 'retry-marker'), `unstable-${attempt}\n`);
  }
  if (fault('backup_source_mode') && first) chmodSync(payload, 0o640);
  if (fault('backup_source_time') && first) utimesSync(payload, WHOLE_SECOND, WHOLE_SECOND);
  if (fault('backup_source_symlink') && first) {
    unlinkSync(join(source, 'line\nlink'));
    symlinkSync('other\n', join(source, 'line\nlink'));
  }
  if (fault('backup_source_relink') && first) {
    unlinkSync(join(source, 'hardlink'));
    copyFileSync(payload, join(source, 'hardlink'));
  }
  return true;
}

/** Copy the Agent Home `source` into `destination`. An absent source leaves an empty Backup. */
function copyHome(source: string, destination: string): boolean {
  if (!makeDirectory(destination)) return false;
  if (!isPresent(source)) return true;
  if (!isPhysicalDirectory(source)) {
    error(`agent root is not a directory: ${source}`);
    return false;
  }
  const copied = copyTree(source, destination, { dereference: false });
  if (!copied.ok) error(copied.error);
  return copied.ok;
}

/** Make the directory `path` and its parents (`mkdir -p`); false when it failed. */
function makeDirectory(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a verified tree to `destination`, which must be free, and check that
 * `source` is gone (`backup_move`, `mv -Tn`). Node has no rename that
 * refuses to replace, so `destination` is checked first; a POSIX rename
 * would replace an empty directory, and this check is what keeps a Backup
 * that appeared in between.
 */
function backupMove(source: string, destination: string): boolean {
  const codex = basename(destination) === '.codex-backup';
  const claude = basename(destination) === '.claude-backup';
  const rollback = basename(source) === '.claude-backup';
  if (fault('backup_promote_second') && codex) return seamFailure('second backup promotion failed');
  if (fault('backup_rollback') && (codex || rollback)) return seamFailure('backup rollback failed');
  if (isPresent(destination)) return false;
  try {
    renameSync(source, destination);
  } catch {
    return false;
  }
  if (isPresent(source)) return false;
  if (fault('backup_final_corrupt') && codex) {
    tryChange(() => chmodSync(join(dirname(destination), '.claude-backup', '.hidden'), 0o600));
  }
  if (fault('backup_promote_ambiguous') && claude) {
    renameSync(destination, `${destination}.unknown`);
    mkdirSync(destination);
  }
  return true;
}

/** The identity of a verified tree before its promotion; said when it cannot be read. */
function verifiedIdentity(path: string): string | undefined {
  const identity = entryIdentity(path, false);
  if (identity === undefined) error(`cannot identify verified backup tree: ${path}`);
  return identity;
}

function isEmptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}
