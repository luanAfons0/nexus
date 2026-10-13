/**
 * The Backup: a copy of each Agent Home that a manifest proves equal to its
 * source, or no Backup at all.
 *
 * These carry over `tests/backup_manifest_test.py` through the one seam a
 * test has, `nexus setup`: a Backup is promoted only when the manifest of
 * the copy equals the source's, so a Setup that ends with a Backup proves
 * that the copier kept what the manifest records, and the Backup is then
 * read directly. A tree the manifest refuses (a FIFO, a root that is no
 * physical directory) refuses Setup and changes nothing. The other half of
 * that file, that a manifest sees a change of content, mode, time, symlink
 * target or hard-link group, needs a change made in the middle of a Setup:
 * those are fault cases, and wait for #82.
 *
 * On Windows a copy's time is exact to ten microseconds, and a home has no
 * FIFO, no newline in a link and no name that is not UTF-8, so those parts
 * run on Linux and macOS alone.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshotTree, writeLock } from './helpers/homes.ts';
import { isAbsent, makeLink, WINDOWS } from './helpers/links.ts';
import { newHome, runNexus } from './helpers/nexus.ts';
import { assertSetupSameAsBash, runSetup, setupResidue } from './helpers/setup.ts';

const BASH_PARITY = WINDOWS && 'the Bash CLI runs on Linux alone';

/** The precision a copy's time is written to: one microsecond, ten on Windows. */
const TIME_UNIT = WINDOWS ? 10_000n : 1_000n;

/** A file name that is not UTF-8, as `backup_manifest_test.py` makes it. */
const NOT_UTF8 = Buffer.from([0x6e, 0x6f, 0x6e, 0x75, 0x74, 0x66, 0x38, 0x5f, 0xff]);

/** A plain path as Python's `repr` writes it: in quotes, each backslash doubled. */
function pythonRepr(path: string): string {
  return `'${path.replaceAll('\\', '\\\\')}'`;
}

/** A path under `dir` named by bytes. */
function bytePath(dir: string, name: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${dir}/`), name]);
}

/**
 * Claude's home of `backup_manifest_test.py`: a hidden file, a nested file
 * with mode 751 and a time with nanoseconds, a hard link to it, and on
 * Linux a symlink whose name and target end in a newline and a file whose
 * name is not UTF-8.
 */
function fixtureHome(home: string): void {
  writeLock(join(home, '.agents', '.skill-lock.json'), []);
  const claude = join(home, '.claude');
  mkdirSync(join(claude, 'nested'), { recursive: true });
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(claude, '.hidden'), 'hidden');
  writeFileSync(join(claude, 'nested', 'payload'), 'payload');
  linkSync(join(claude, 'nested', 'payload'), join(claude, 'hardlink'));
  if (!WINDOWS) {
    symlinkSync(Buffer.from('literal\n'), join(claude, 'nested', 'line\nlink'));
    writeFileSync(bytePath(claude, NOT_UTF8), 'bytes');
    chmodSync(join(claude, 'nested', 'payload'), 0o751);
  }
  // 2026-01-01T00:00:00.123456789Z, to the nanosecond where the system keeps it.
  utimesSync(join(claude, 'nested', 'payload'), 1767225600.123456, 1767225600.123456);
  // Node writes microseconds; `touch` writes the nanoseconds a copy cannot carry.
  if (!WINDOWS) {
    spawnSync('touch', ['-d', '2026-01-01 00:00:00.123456789', join(claude, 'nested', 'payload')]);
  }
}

test('the Backup keeps hidden files, hard links, modes, sub-second times and symlink bytes', () => {
  const home = newHome('backup_fidelity');
  fixtureHome(home);
  const claude = join(home, '.claude');
  // Link adds to Claude's home after the Backup, so its root is read first.
  const sourceRoot = lstatSync(claude, { bigint: true });
  const run = runNexus(home, ['setup']);
  assert.equal(run.status, 0, run.stderr);
  const backup = join(home, '.claude-backup');
  assert.equal(readFileSync(join(backup, '.hidden'), 'utf8'), 'hidden');
  const payload = lstatSync(join(backup, 'nested', 'payload'), { bigint: true });
  const hardlink = lstatSync(join(backup, 'hardlink'), { bigint: true });
  assert.equal(payload.ino, hardlink.ino, 'the hard-link group is kept');
  assert.equal(payload.nlink, 2n);
  const source = lstatSync(join(claude, 'nested', 'payload'), { bigint: true });
  assert.notEqual(payload.ino, source.ino, 'the Backup is a copy, not a link');
  assert.equal(payload.mtimeNs / TIME_UNIT, source.mtimeNs / TIME_UNIT);
  assert.equal(payload.mode, source.mode);
  const root = lstatSync(backup, { bigint: true });
  assert.equal(root.mode, sourceRoot.mode);
  assert.equal(root.mtimeNs / TIME_UNIT, sourceRoot.mtimeNs / TIME_UNIT);
  if (!WINDOWS) {
    assert.equal((Number(payload.mode) & 0o7777).toString(8), '751');
    const link = join(backup, 'nested', 'line\nlink');
    assert.ok(readlinkSync(link, { encoding: 'buffer' }).equals(Buffer.from('literal\n')));
    assert.equal(readFileSync(bytePath(backup, NOT_UTF8), 'utf8'), 'bytes');
  }
  // The source is left as it was.
  assert.equal(source.nlink, 2n);
  assert.deepEqual(setupResidue(home), []);
});

test('the Backup keeps a symlink whose target ends in a newline', { skip: WINDOWS && 'Windows cannot hold a newline in a link target' }, () => {
  const { home, run } = runSetup('backup_trailing_newline_link', (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), []);
    mkdirSync(join(home, '.claude'));
    symlinkSync('literal-target\n', join(home, '.claude', 'trailing-newline-link'));
  });
  assert.equal(run.status, 0, run.stderr);
  const copy = readlinkSync(join(home, '.claude-backup', 'trailing-newline-link'));
  assert.equal(copy, 'literal-target\n');
});

test('a FIFO in an Agent Home refuses setup with the manifest sentence and changes nothing', { skip: WINDOWS && 'Windows has no FIFO' }, () => {
  const home = newHome('backup_fifo');
  writeLock(join(home, '.agents', '.skill-lock.json'), []);
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'marker'), 'live\n');
  const fifo = join(home, '.claude', 'unsupported-fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const before = snapshotTree(home);
  const run = runNexus(home, ['setup']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    `backup manifest: unsupported agent backup entry (device/FIFO/socket): '${fifo}'\n` +
      'nexus: error: cannot create complete agent backups\n',
  );
  assert.deepEqual(snapshotTree(home), before);
  assert.ok(isAbsent(join(home, '.claude-backup')));
  assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')));
  assert.deepEqual(setupResidue(home), []);
});

test('an Agent Home that is a file or a symlink refuses setup and changes nothing', () => {
  const kinds: readonly (readonly [string, (path: string, home: string) => void])[] = [
    ['file', (path) => writeFileSync(path, 'not a directory\n')],
    [
      'symlink',
      (path, home) => {
        mkdirSync(join(home, 'real-claude'));
        makeLink('real-claude', path);
      },
    ],
  ];
  for (const [kind, make] of kinds) {
    const home = newHome(`backup_root_${kind}`);
    writeLock(join(home, '.agents', '.skill-lock.json'), []);
    const claude = join(home, '.claude');
    make(claude, home);
    const before = snapshotTree(home);
    const run = runNexus(home, ['setup']);
    assert.equal(run.status, 1, kind);
    assert.equal(
      run.stderr,
      `backup manifest: agent root is not a physical directory: ${pythonRepr(claude)}\n` +
        'nexus: error: cannot create complete agent backups\n',
      kind,
    );
    assert.deepEqual(snapshotTree(home), before, kind);
    assert.ok(isAbsent(join(home, '.claude-backup')), kind);
    assert.deepEqual(setupResidue(home), [], kind);
  }
});

test('the Backup says the same bytes and leaves the same trees as the Bash CLI', { skip: BASH_PARITY }, () => {
  assertSetupSameAsBash('parity_fixture', fixtureHome);
  assertSetupSameAsBash('parity_fifo', (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), []);
    mkdirSync(join(home, '.claude'));
    spawnSync('mkfifo', [join(home, '.claude', 'fifo')]);
  });
  assertSetupSameAsBash('parity_root_file', (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), []);
    writeFileSync(join(home, '.codex'), 'not a directory\n');
  });
});
