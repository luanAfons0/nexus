/**
 * Seam 3, for a signal that stops Setup: a fault point holds Setup in one
 * window, and the test stops it there, as `term_recovery`,
 * `setup_finalization_signal_window` and `setup_canonical_scan_signal_cleanup`
 * of the Bash suite did. Setup must clean what is its own, name every path a
 * person must review, release its mutex, and exit 143.
 *
 * The windows: `pre` holds a lock Snapshot before anything is published,
 * `post` holds one after the lock and both Backups are published,
 * `finalization` holds the cleanup of the lock candidates, and `scan` holds
 * the symlink scan of a Canonical Root skill.
 *
 * A test stops Setup in one of two ways. On Linux and macOS it sends a real
 * SIGTERM, then releases the window. Windows runs no handler for a SIGTERM
 * that another process sends, so there, and on Linux and macOS too, the test
 * writes the window's stop file, and the fault point raises SIGTERM inside
 * the CLI. Both must end the same way.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { writeLock, writeSkill } from './helpers/homes.ts';
import { isAbsent, WINDOWS } from './helpers/links.ts';
import { newHome, type Run, type Started, startNexus } from './helpers/nexus.ts';
import { setupResidue } from './helpers/setup.ts';

/** How a test stops Setup in a window. */
type Stop = 'signal' | 'stop file';

/** The ways each case stops Setup on this system. */
const STOPS: readonly Stop[] = WINDOWS ? ['stop file'] : ['signal', 'stop file'];

/** How long a test waits for a handshake before it gives up, in milliseconds. */
const HANDSHAKE_MS = 30_000;

/** Wait until `path` exists; fail, with what the CLI said, if it ends or takes too long. */
async function waitFor(path: string, started: Started): Promise<void> {
  let ended: Run | undefined;
  void started.done.then((run) => {
    ended = run;
  });
  const deadline = Date.now() + HANDSHAKE_MS;
  while (!existsSync(path)) {
    if (ended !== undefined) {
      assert.fail(`the CLI ended before ${path}:\n${ended.stdout}${ended.stderr}`);
    }
    if (Date.now() > deadline) assert.fail(`no ${path} after ${HANDSHAKE_MS} ms`);
    await sleep(20);
  }
}

/**
 * Run Setup in `home` with the fault point `fault`, wait for `window`'s
 * handshake, call `atHandshake`, stop Setup the `stop` way, and give back
 * what it left.
 */
async function stopSetup(
  home: string,
  fault: string,
  window: string,
  stop: Stop,
  options: { readonly env?: Readonly<Record<string, string>>; readonly atHandshake?: () => void } = {},
): Promise<Run> {
  const started = startNexus(home, ['setup'], { env: { ...options.env, NEXUS_FAULT: fault } });
  await waitFor(join(home, `${window}-handshake`), started);
  options.atHandshake?.();
  if (stop === 'signal') {
    started.child.kill('SIGTERM');
    writeFileSync(join(home, `${window}-release`), '');
  } else {
    writeFileSync(join(home, `${window}-stop`), '');
  }
  return started.done;
}

/** A lock with no skills, and both Agent Homes. */
function termHome(name: string): string {
  const home = newHome(name);
  writeLock(join(home, '.agents', '.skill-lock.json'), []);
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.claude', 'marker'), 'live');
  writeFileSync(join(home, '.codex', 'marker'), 'live');
  return home;
}

/** The paths of the last `retained setup temp paths: ` sentence. */
function retainedTemps(output: string): string {
  const found = [...output.matchAll(/retained setup temp paths: (.*)/g)].at(-1)?.[1];
  assert.ok(found !== undefined, output);
  return found;
}

/** The entries of the Nexus home whose names start with one of `prefixes`. */
function inNexusHome(home: string, prefixes: readonly string[]): readonly string[] {
  return readdirSync(join(home, '.nexus')).filter((name) => prefixes.some((p) => name.startsWith(p)));
}

for (const stop of STOPS) {
  test(`a ${stop} before publication leaves the agents as they were and no Residue`, async () => {
    const home = termHome(`term_pre_${stop.replace(' ', '_')}`);
    const run = await stopSetup(home, 'term_pre', 'pre', stop);
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 143, output);
    for (const path of ['.claude-backup', '.codex-backup', '.nexus/skill-lock.json']) {
      assert.ok(isAbsent(join(home, path)), path);
    }
    assert.ok(existsSync(join(home, '.claude', 'marker')));
    assert.ok(existsSync(join(home, '.codex', 'marker')));
    assert.match(output, /interrupted|rerun|retained/);
    assert.deepEqual(setupResidue(home), []);
    assert.ok(isAbsent(join(home, '.nexus', '.nexus-setup.lock')));
  });

  test(`a ${stop} after publication keeps the lock and both Backups, and says to link`, async () => {
    const home = termHome(`term_post_${stop.replace(' ', '_')}`);
    const run = await stopSetup(home, 'term_post', 'post', stop, {
      atHandshake: () => {
        assert.ok(existsSync(join(home, '.claude-backup')));
        assert.ok(existsSync(join(home, '.codex-backup')));
        assert.ok(existsSync(join(home, '.nexus', 'skill-lock.json')));
      },
    });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 143, output);
    for (const words of [join(home, '.nexus', 'skill-lock.json'), '/nexus-link', '$nexus-link']) {
      assert.ok(output.includes(words), output);
    }
    assert.ok(isAbsent(join(home, '.nexus', '.nexus-setup.lock')));
    assert.deepEqual(setupResidue(home), []);
    for (const prefix of ['.nexus-lock.', '.nexus-lock-candidates.', '.nexus-setup-source.', '.nexus-setup-copy.']) {
      assert.ok(!output.includes(prefix), output);
    }
  });

  test(`a ${stop} before publication names a lock Snapshot it cannot remove`, async () => {
    const home = termHome(`term_pre_cleanup_fail_${stop.replace(' ', '_')}`);
    const run = await stopSetup(home, 'term_pre_cleanup_fail', 'pre', stop);
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 143, output);
    const retained = retainedTemps(output);
    assert.ok(existsSync(retained), output);
    assert.ok(retained.startsWith(join(home, '.nexus', '.nexus-lock.')), output);
    assert.ok(output.includes('rerun setup'), output);
  });

  test(`a ${stop} after publication names a lock Snapshot it cannot remove`, async () => {
    const home = termHome(`term_post_cleanup_fail_${stop.replace(' ', '_')}`);
    const run = await stopSetup(home, 'term_post_cleanup_fail', 'post', stop);
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 143, output);
    const retained = retainedTemps(output);
    assert.ok(existsSync(retained), output);
    assert.ok(retained.startsWith(join(home, '.nexus', '.nexus-lock.')), output);
    for (const words of [join(home, '.nexus', 'skill-lock.json'), '/nexus-link', 'retained final/recovery paths']) {
      assert.ok(output.includes(words), output);
    }
    assert.deepEqual(inNexusHome(home, ['.nexus-setup-']), []);
  });

  test(`a ${stop} while setup cleans up keeps what it published and releases the mutex`, async () => {
    const home = newHome(`finalization_${stop.replace(' ', '_')}`);
    writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
    const run = await stopSetup(home, 'final_cleanup', 'finalization', stop);
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 143, output);
    assert.ok(existsSync(join(home, '.claude-backup')));
    assert.ok(existsSync(join(home, '.codex-backup')));
    assert.ok(existsSync(join(home, '.nexus', 'skill-lock.json')));
    assert.ok(isAbsent(join(home, '.nexus', '.nexus-setup.lock')));
    assert.deepEqual(inNexusHome(home, ['.nexus-lock-candidates.', '.nexus-setup-']), []);
    for (const words of ['setup interrupted', '/nexus-link', '$nexus-link']) {
      assert.ok(output.includes(words), output);
    }
  });

  test(`a ${stop} during the canonical symlink scan leaves nothing in TMPDIR`, async () => {
    const home = newHome(`canonical_scan_${stop.replace(' ', '_')}`);
    mkdirSync(join(home, 'tmp'));
    writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
    writeSkill(join(home, '.agents', 'skills'), 'alpha');
    const run = await stopSetup(home, 'canonical_scan_window', 'scan', stop, {
      env: { TMPDIR: `${join(home, 'tmp')}/` },
    });
    assert.equal(run.status, 143, run.stdout + run.stderr);
    assert.deepEqual(readdirSync(join(home, 'tmp')), []);
  });
}
