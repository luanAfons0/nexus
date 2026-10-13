/**
 * Seam 3, for Setup: named fault points in the Backup, the publication of
 * the Nexus Lock and the Canonical Root, driven through the CLI as a
 * subprocess (Seam 1).
 *
 * These are the fault cases of the Bash suite, which made them with Bash
 * function overrides (`setup_backup_transaction_and_absent_roots`,
 * `setup_backup_retries_and_manifest_bound`,
 * `setup_lock_publication_verification`,
 * `setup_canonical_failures_retain_publication`, the late collision and
 * repoint, and the scan failure), each asserting what the Bash case
 * asserted. Three more come from cases that sourced Bash internals:
 * `discover_lock_uses_immutable_snapshots`, the change-detection half of
 * the Python manifest test (a change of content, mode, a nanosecond of
 * time, a symlink's target or a hard link, made while the Backup copies),
 * and `backup_final_corrupt`, the one fault point of the Bash suite that no
 * Bash case ran.
 *
 * On Windows a home's links are junctions, as `makeLink` makes them. A
 * newline in a link's text, a mode other than read-only and a nanosecond
 * time cannot be made there, so those cases run on Linux and macOS alone.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { snapshotTree, writeLock, writeSkill } from './helpers/homes.ts';
import { assertLinkText, isAbsent, linkText, makeLink, WINDOWS } from './helpers/links.ts';
import { newHome, type Run, runNexus } from './helpers/nexus.ts';
import { setupResidue } from './helpers/setup.ts';

const POSIX_ONLY = WINDOWS && 'Windows cannot make this change';

/** `2026-01-01 00:00:00.123456`, local, as a time `utimes` takes. */
const EARLY = new Date(2026, 0, 1).getTime() / 1000 + 0.123456;

/** 2026-01-01T00:00:00Z, the whole second the fault points write. */
const WHOLE_SECOND = Date.UTC(2026, 0, 1) / 1000;

/** The trees of a home that Setup reads, and must leave as they were before publication. */
const SOURCES: readonly string[] = ['.claude', '.codex', '.agents'];

/**
 * A home built by `build`, Setup run on it with the fault point `fault`,
 * and the trees Setup reads as they were before it ran.
 */
function setupWithFault(name: string, fault: string, build: (home: string) => void) {
  const home = newHome(name);
  build(home);
  const before = sourceTrees(home);
  return { home, before, run: runNexus(home, ['setup'], { env: { NEXUS_FAULT: fault } }) };
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A lock with no skills, and both Agent Homes holding `marker`. */
function markedHome(home: string): void {
  writeLock(join(home, '.agents', '.skill-lock.json'), []);
  write(join(home, '.claude', 'marker'), 'live\n');
  write(join(home, '.codex', 'marker'), 'live\n');
}

/** A lock with no skills, and both Agent Homes as empty directories. */
function emptyHome(home: string): void {
  writeLock(join(home, '.agents', '.skill-lock.json'), []);
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.codex'));
}

/** `alpha` in the lock, as a Canonical Root symlink to a skill in Claude's home. */
function canonicalLinkHome(home: string): void {
  writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
  write(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'skill\n');
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
  makeLink('../../.claude/skills/alpha', join(home, '.agents', 'skills', 'alpha'));
}

/** Both Agent Homes and `~/.agents`, as one snapshot. */
function sourceTrees(home: string): string {
  return SOURCES.map((dir) => `${dir}:\n${snapshotTree(join(home, dir)).join('\n')}`).join('\n');
}

/** Assert that Setup published nothing: no Backup, no Nexus Lock, no Residue. */
function assertNothingPublished(home: string, run: Run): void {
  assert.notEqual(run.status, 0, run.stderr);
  assert.ok(isAbsent(join(home, '.claude-backup')), run.stderr);
  assert.ok(isAbsent(join(home, '.codex-backup')), run.stderr);
  assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')), run.stderr);
  assert.deepEqual(setupResidue(home), []);
}

/** Assert that Setup published the lock and both Backups, and stopped after. */
function assertPublished(home: string, run: Run): void {
  assert.notEqual(run.status, 0, run.stderr);
  assert.ok(statSync(join(home, '.nexus', 'skill-lock.json')).isFile(), run.stderr);
  assert.ok(lstatSync(join(home, '.claude-backup')).isDirectory(), run.stderr);
  assert.ok(lstatSync(join(home, '.codex-backup')).isDirectory(), run.stderr);
}

/** The text after the last `<label>: ` in `output`. */
function lastNamed(output: string, label: string): string {
  const found = [...output.matchAll(new RegExp(`${label}: (.*)`, 'g'))].at(-1)?.[1];
  assert.ok(found !== undefined, `no "${label}" in:\n${output}`);
  return found;
}

/** The Backup's words when a copy is not the tree it copied. */
const NOT_VERIFIED = /backup verification failed|agent state changed during backup/;

test('a Backup copy that fails refuses setup and changes nothing', () => {
  const { home, run, before } = setupWithFault('backup_copy_fail', 'backup_copy_fail', markedHome);
  assertNothingPublished(home, run);
  assert.equal(sourceTrees(home), before);
  assert.match(run.stderr, /test seam: backup copy failed/);
  assert.match(run.stderr, /cannot create complete agent backups/);
  assert.equal(readFileSync(join(home, '.claude', 'marker'), 'utf8'), 'live\n');
  assert.equal(readFileSync(join(home, '.codex', 'marker'), 'utf8'), 'live\n');
});

test('a Backup copy that copied nothing is seen and refuses setup', () => {
  const { home, run, before } = setupWithFault('backup_copy_false', 'backup_copy_false', (home) => {
    emptyHome(home);
    write(join(home, '.claude', '.hidden'), 'hidden-original\n');
    makeLink('/external/ordinary', join(home, '.claude', 'ordinary-link'));
  });
  assertNothingPublished(home, run);
  assert.match(run.stderr, NOT_VERIFIED);
  assert.equal(sourceTrees(home), before);
});

test('a file added to a Backup copy is seen and refuses setup', () => {
  const { home, run } = setupWithFault('backup_copy_corrupt', 'backup_copy_corrupt', (home) => {
    emptyHome(home);
    write(join(home, '.claude', '.hidden'), 'hidden-original\n');
    chmodSync(join(home, '.claude', '.hidden'), 0o644);
  });
  assertNothingPublished(home, run);
  assert.match(run.stderr, NOT_VERIFIED);
});

test("a copy whose root lost the source's mode and time is seen and refuses setup", () => {
  const { home, run } = setupWithFault('backup_root_corrupt', 'backup_root_corrupt', (home) => {
    emptyHome(home);
    write(join(home, '.claude', 'child'), 'same-child\n');
    chmodSync(join(home, '.claude'), 0o751);
    utimesSync(join(home, '.claude'), EARLY, EARLY);
  });
  assertNothingPublished(home, run);
  assert.match(run.stderr, NOT_VERIFIED);
});

test('a copied file with another sub-second time is seen and refuses setup', () => {
  const { home, run } = setupWithFault('backup_child_corrupt', 'backup_child_corrupt', (home) => {
    emptyHome(home);
    write(join(home, '.claude', 'child'), 'same-child\n');
    utimesSync(join(home, '.claude', 'child'), EARLY, EARLY);
  });
  assertNothingPublished(home, run);
  assert.match(run.stderr, NOT_VERIFIED);
});

test('a copied symlink that lost its trailing newline is seen and refuses setup', { skip: POSIX_ONLY }, () => {
  const { home, run } = setupWithFault('backup_symlink_corrupt', 'backup_symlink_corrupt', (home) => {
    emptyHome(home);
    symlinkSync('literal-target\n', join(home, '.claude', 'trailing-newline-link'));
  });
  assertNothingPublished(home, run);
  assert.match(run.stderr, NOT_VERIFIED);
});

test('a promoted Backup that is not the verified tree refuses setup and keeps every tree', () => {
  const { home, run } = setupWithFault('backup_promotion_identity', 'backup_promote_ambiguous', emptyHome);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /backup promotion changed verified tree identity/);
  for (const dir of ['.claude-backup', '.codex-backup', '.claude-backup.unknown']) {
    assert.ok(lstatSync(join(home, dir)).isDirectory(), dir);
  }
  assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')));
});

test('a second Backup that cannot be promoted takes the first back', () => {
  const { home, run } = setupWithFault('backup_promotion_failure', 'backup_promote_second', (home) =>
    writeLock(join(home, '.agents', '.skill-lock.json'), []),
  );
  assertNothingPublished(home, run);
  assert.match(run.stderr, /test seam: second backup promotion failed/);
});

test('a Backup that cannot be taken back is named with the transaction that holds the other', () => {
  const { home, run } = setupWithFault('backup_rollback_recovery', 'backup_rollback', (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), []);
    write(join(home, '.claude', 'marker'), 'claude-original\n');
    write(join(home, '.codex', 'marker'), 'codex-original\n');
  });
  assert.notEqual(run.status, 0);
  const tx = /; (.*\.nexus-setup-backup\.[^ ]*) \(Codex backup:/.exec(run.stderr)?.[1];
  assert.ok(tx !== undefined, run.stderr);
  const codex = join(tx, 'codex-backup');
  assert.equal(readFileSync(join(home, '.claude-backup', 'marker'), 'utf8'), 'claude-original\n');
  assert.equal(readFileSync(join(codex, 'marker'), 'utf8'), 'codex-original\n');
  for (const path of [join(home, '.claude-backup'), tx, codex]) assert.ok(run.stderr.includes(path));
  assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')));
  const txs = readdirSync(home).filter((name) => name.startsWith('.nexus-setup-backup.'));
  assert.deepEqual(txs.map((name) => join(home, name)), [tx]);
  const prefixes = ['.nexus-setup-source.', '.nexus-setup-copy.'];
  assert.deepEqual(setupResidue(home, prefixes), []);
});

test('an Agent Home that changes once during the Backup is copied again', () => {
  const { home, run } = setupWithFault('backup_retry_once', 'backup_retry_once', (home) => {
    emptyHome(home);
    write(join(home, '.claude', 'retry-marker'), 'initial\n');
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(join(home, '.claude-backup', 'retry-marker'), 'utf8'), /retry-state/);
});

test('an Agent Home that keeps changing refuses setup and asks to close the agents', () => {
  const { home, run } = setupWithFault('backup_retry_always', 'backup_retry_always', (home) => {
    emptyHome(home);
    write(join(home, '.claude', 'retry-marker'), 'live\n');
    write(join(home, '.codex', 'retry-marker'), 'live\n');
  });
  assertNothingPublished(home, run);
  assert.match(
    run.stderr,
    /agent state changed during backup; close Claude and Codex and retry/,
  );
  assert.ok(statSync(join(home, '.claude', 'retry-marker')).isFile());
  assert.ok(statSync(join(home, '.codex', 'retry-marker')).isFile());
});

test('the Backup reads three manifests of each Agent Home, present or absent', () => {
  for (const [name, build] of [
    ['backup_manifest_bound', emptyHome],
    ['backup_manifest_bound_absent', (home: string) => writeLock(join(home, '.agents', '.skill-lock.json'), [])],
  ] as const) {
    const { home, run } = setupWithFault(name, 'backup_manifest_count', build);
    assert.equal(run.status, 0, run.stderr);
    const calls = readFileSync(join(home, 'manifest-calls'), 'utf8').split('\n').filter(Boolean);
    assert.equal(calls.length, 6, calls.join('\n'));
    assert.ok(lstatSync(join(home, '.claude-backup')).isDirectory());
    assert.ok(lstatSync(join(home, '.codex-backup')).isDirectory());
  }
});

test('a change inside a promoted Backup is past what setup checks: setup completes and the Agent Home is kept', () => {
  const { home, run } = setupWithFault('backup_final_corrupt', 'backup_final_corrupt', (home) => {
    emptyHome(home);
    write(join(home, '.claude', '.hidden'), 'hidden\n');
    chmodSync(join(home, '.claude', '.hidden'), 0o644);
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(statSync(join(home, '.nexus', 'skill-lock.json')).isFile());
  assert.equal(readFileSync(join(home, '.claude', '.hidden'), 'utf8'), 'hidden\n');
  assert.equal(readFileSync(join(home, '.claude-backup', '.hidden'), 'utf8'), 'hidden\n');
  if (!WINDOWS) {
    assert.equal(statSync(join(home, '.claude', '.hidden')).mode & 0o777, 0o644);
    assert.equal(statSync(join(home, '.claude-backup', '.hidden')).mode & 0o777, 0o600);
  }
});

/**
 * A home for the change-detection cases of the Python manifest test: in
 * Claude's home, `payload` at a whole second, its hard link `hardlink`, and
 * on Linux and macOS a symlink named `line\nlink` whose text is `literal\n`.
 */
function changingHome(home: string): void {
  emptyHome(home);
  const claude = join(home, '.claude');
  write(join(claude, 'payload'), 'payload');
  chmodSync(join(claude, 'payload'), 0o751);
  utimesSync(join(claude, 'payload'), WHOLE_SECOND, WHOLE_SECOND);
  linkSync(join(claude, 'payload'), join(claude, 'hardlink'));
  if (!WINDOWS) symlinkSync('literal\n', join(claude, 'line\nlink'));
}

/** Assert that the Backup saw the source change, copied it again, and completed. */
function assertCopiedAgain(home: string, run: Run): void {
  assert.equal(run.status, 0, run.stderr);
  const claude = join(home, '.claude');
  assert.ok(run.stderr.includes(`backup verification failed for ${claude}`), run.stderr);
}

test('a change of content alone, during the Backup, is seen and copied again', () => {
  const { home, run } = setupWithFault('manifest_content', 'backup_source_content', changingHome);
  assertCopiedAgain(home, run);
  assert.equal(readFileSync(join(home, '.claude-backup', 'payload'), 'utf8'), 'changed');
});

test('a change of mode, during the Backup, is seen and copied again', { skip: POSIX_ONLY }, () => {
  const { home, run } = setupWithFault('manifest_mode', 'backup_source_mode', changingHome);
  assertCopiedAgain(home, run);
  assert.equal(statSync(join(home, '.claude-backup', 'payload')).mode & 0o777, 0o640);
});

test('a change of one nanosecond, during the Backup, is seen and copied again', { skip: POSIX_ONLY }, () => {
  const { home, run } = setupWithFault('manifest_time', 'backup_source_time', (home) => {
    changingHome(home);
    // Node writes no nanosecond; GNU touch does.
    const touch = spawnSync('touch', ['-d', '@1767225600.000000001', join(home, '.claude', 'payload')]);
    assert.equal(touch.status, 0, String(touch.stderr));
    const ns = lstatSync(join(home, '.claude', 'payload'), { bigint: true }).mtimeNs;
    assert.equal(ns, 1767225600000000001n);
  });
  assertCopiedAgain(home, run);
});

test("a change of a symlink's text, during the Backup, is seen and copied again", { skip: POSIX_ONLY }, () => {
  const { home, run } = setupWithFault('manifest_symlink', 'backup_source_symlink', changingHome);
  assertCopiedAgain(home, run);
  assert.equal(linkText(join(home, '.claude-backup', 'line\nlink')), 'other\n');
});

test('a hard link broken during the Backup is seen and copied again', () => {
  const { home, run } = setupWithFault('manifest_hard_link', 'backup_source_relink', changingHome);
  assertCopiedAgain(home, run);
  const backup = join(home, '.claude-backup');
  const payload = lstatSync(join(backup, 'payload'), { bigint: true }).ino;
  assert.notEqual(lstatSync(join(backup, 'hardlink'), { bigint: true }).ino, payload);
});

test('a lock copy that fails its check publishes no lock and keeps the Backups', () => {
  const { home, run, before } = setupWithFault('lock_copy_corrupt', 'lock_copy_corrupt', markedHome);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /atomic copy staging verification failed/);
  assert.equal(sourceTrees(home), before);
  assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')));
  assert.ok(lstatSync(join(home, '.claude-backup')).isDirectory());
  assert.ok(lstatSync(join(home, '.codex-backup')).isDirectory());
  assert.deepEqual(setupResidue(home), []);
});

test('a lock that changes after its publication keeps it and both Backups, and says to link', () => {
  const { home, run } = setupWithFault('lock_post_publish', 'lock_post_publish_corrupt', emptyHome);
  assertPublished(home, run);
  for (const words of ['setup is now initialized/disabled', '/nexus-link', '$nexus-link']) {
    assert.ok(run.stderr.includes(words), run.stderr);
  }
  // The advice names the CLI in the one form that works on every system.
  const cli = join(home, '.nexus', 'src', 'nexus.js');
  assert.ok(run.stderr.includes(`(CLI: node "${cli}" link)\n`), run.stderr);
  assert.deepEqual(setupResidue(home), []);
});

test('setup Publishes the candidate Snapshot it read, not the candidate changed since', () => {
  const { home, run } = setupWithFault('discover_snapshot', 'discovery_mutate', (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
    writeSkill(join(home, '.agents', 'skills'), 'alpha');
    write(join(home, 'expected'), readFileSync(join(home, '.agents', '.skill-lock.json'), 'utf8'));
  });
  assert.equal(run.status, 0, run.stderr);
  const expected = readFileSync(join(home, 'expected'));
  assert.ok(readFileSync(join(home, '.nexus', 'skill-lock.json')).equals(expected));
  assert.match(readFileSync(join(home, '.agents', '.skill-lock.json'), 'utf8'), /beta/);
  const candidates = readdirSync(join(home, '.nexus'));
  assert.deepEqual(candidates.filter((name) => name.startsWith('.nexus-lock-candidates.')), []);
});

test('a canonical symlink that cannot be put back stays in its named recovery directory', () => {
  const { home, run } = setupWithFault('canonical_restore', 'canonical_restore', canonicalLinkHome);
  assertPublished(home, run);
  const recovery = lastNamed(run.stderr, 'canonical recovery retained');
  // The symlink keeps its text; a junction's is the absolute path it names.
  const text = WINDOWS ? join(home, '.claude', 'skills', 'alpha') : '../../.claude/skills/alpha';
  assert.equal(linkText(join(recovery, 'original')), text);
  const canonical = join(home, '.agents', 'skills');
  assert.deepEqual(readdirSync(canonical).filter((name) => name.startsWith('.nexus-canonical-tmp.')), []);
  assert.ok(lstatSync(join(home, '.claude', 'skills', 'alpha')).isDirectory());
});

test('a canonical temp that cannot be removed is named with the recovery directory', () => {
  const { run } = setupWithFault('canonical_cleanup', 'canonical_cleanup', canonicalLinkHome);
  assert.notEqual(run.status, 0);
  const recovery = lastNamed(run.stderr, 'canonical recovery retained');
  const temp = lastNamed(run.stderr, 'canonical temp retained');
  assert.notEqual(linkText(join(recovery, 'original')), undefined);
  assert.ok(lstatSync(temp).isDirectory());
});

test('a canonical copy that cannot be promoted puts the symlink back and leaves no Residue', () => {
  const { home, run } = setupWithFault('canonical_promote', 'canonical_promote', canonicalLinkHome);
  assertPublished(home, run);
  assertLinkText(join(home, '.agents', 'skills', 'alpha'), '../../.claude/skills/alpha');
  assert.deepEqual(setupResidue(home), []);
});

test('a file put at a canonical entry after its validation is kept', () => {
  const { home, run } = setupWithFault('canonical_late_collision', 'canonical_late_collision', canonicalLinkHome);
  assert.notEqual(run.status, 0);
  const entry = join(home, '.agents', 'skills', 'alpha');
  assert.ok(lstatSync(entry).isFile(), run.stderr);
  assert.equal(readFileSync(entry, 'utf8'), 'late collision\n');
});

test('a canonical entry repointed after its validation is kept', () => {
  const { home, run } = setupWithFault('canonical_late_repoint', 'canonical_late_repoint', (home) => {
    canonicalLinkHome(home);
    mkdirSync(join(home, 'elsewhere'));
  });
  assert.notEqual(run.status, 0);
  assertLinkText(join(home, '.agents', 'skills', 'alpha'), join(home, 'elsewhere'));
});

test('a canonical symlink scan that fails is said and fails setup', () => {
  const { run } = setupWithFault('canonical_scan_failure', 'canonical_find_fail', (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
    writeSkill(join(home, '.agents', 'skills'), 'alpha');
    writeSkill(join(home, '.claude', 'skills'), 'alpha');
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /cannot scan canonical skill symlinks/);
});

for (const [what, fault] of [
  ['empty', 'backup_destination_empty'],
  ['holding a file', 'backup_destination_full'],
] as const) {
  test(`a Backup path that appears ${what} just before its promotion is kept, and setup refuses`, () => {
    const { home, run, before } = setupWithFault(fault, fault, markedHome);
    assert.notEqual(run.status, 0, run.stderr);
    assert.match(run.stderr, /cannot promote Claude backup/);
    const backup = join(home, '.claude-backup');
    assert.ok(lstatSync(backup).isDirectory(), run.stderr);
    const held = fault === 'backup_destination_full' ? ['occupant'] : [];
    assert.deepEqual(readdirSync(backup), held);
    if (held.length > 0) assert.equal(readFileSync(join(backup, 'occupant'), 'utf8'), 'occupant\n');
    assert.ok(isAbsent(join(home, '.codex-backup')));
    assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')));
    assert.equal(sourceTrees(home), before);
    assert.deepEqual(setupResidue(home), []);
  });
}

test('a directory that appears at a canonical entry just before the copy moves in is kept', () => {
  const { home, run } = setupWithFault(
    'canonical_destination_empty',
    'canonical_destination_empty',
    canonicalLinkHome,
  );
  assert.notEqual(run.status, 0, run.stderr);
  const entry = join(home, '.agents', 'skills', 'alpha');
  assert.ok(lstatSync(entry).isDirectory(), run.stderr);
  assert.deepEqual(readdirSync(entry), []);
  assert.match(run.stderr, /canonical promotion is ambiguous; retained current/);
  const recovery = lastNamed(run.stderr, 'recovery');
  assert.notEqual(linkText(join(recovery, 'original')), undefined);
});
