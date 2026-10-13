/**
 * The test helper itself: it keeps every run inside a marked home under the
 * temporary root, and its fake programs run from PATH on Linux and Windows
 * and record each call.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fakeCalls,
  fakePath,
  installFake,
  newHome,
  runNexus,
  testRoot,
} from './helpers/nexus.ts';

/** Run a fake by its bare name from PATH, as a program, the way the CLI will. */
function runFake(home: string, name: string, args: readonly string[], exit = '0') {
  const env = { ...process.env, PATH: fakePath(home, ''), NEXUS_FAKE_EXIT: exit };
  // On Windows a `.cmd` program runs through cmd.exe, named by its full path
  // because this PATH holds the fakes alone.
  const result =
    process.platform === 'win32'
      ? spawnSync(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `"${[`"${name}.cmd"`, ...args].join(' ')}"`],
          { env, encoding: 'utf8', windowsVerbatimArguments: true },
        )
      : spawnSync(name, args, { env, encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  return result;
}

test('the helper refuses to run the CLI against a home outside the temporary root', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nexus-outside-'));
  try {
    writeFileSync(join(outside, '.nexus-test-home'), '');
    assert.throws(() => runNexus(outside, ['help']), /refusing to run outside a validated test home/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the helper refuses to run the CLI against an unmarked directory under the root', () => {
  const unmarked = join(testRoot(), 'unmarked');
  mkdirSync(unmarked);
  assert.throws(() => runNexus(unmarked, ['help']), /refusing to run outside a validated test home/);
  assert.throws(
    () => runNexus(join(testRoot(), 'missing'), ['help']),
    /refusing to run outside a validated test home/,
  );
});

test('a test home holds the marker, a Nexus home and the Control Skills', () => {
  const home = newHome('shape');
  assert.ok(existsSync(join(home, '.nexus-test-home')));
  for (const skill of ['nexus', 'nexus-setup', 'nexus-link', 'nexus-help']) {
    assert.ok(existsSync(join(home, '.nexus', 'skills', skill, 'SKILL.md')), skill);
  }
});

test('the fake gh and npx run from PATH and record their arguments', () => {
  const home = newHome('fakes');
  installFake(home, 'gh');
  installFake(home, 'npx');
  assert.equal(runFake(home, 'gh', ['auth', 'status']).status, 0);
  assert.equal(runFake(home, 'gh', ['api', 'repos/owner/name/commits']).status, 0);
  assert.equal(runFake(home, 'npx', ['--yes', 'skills', 'add', 'source']).status, 0);
  assert.deepEqual(fakeCalls(home, 'gh'), [
    ['auth', 'status'],
    ['api', 'repos/owner/name/commits'],
  ]);
  assert.deepEqual(fakeCalls(home, 'npx'), [['--yes', 'skills', 'add', 'source']]);
  assert.deepEqual(fakeCalls(home, 'git'), []);
});

test('a fake runs the behaviour it was given, with its output and exit code', () => {
  const home = newHome('behaviour');
  installFake(home, 'gh', 'echo.ts');
  const run = runFake(home, 'gh', ['alpha', 'beta'], '42');
  assert.equal(run.status, 42);
  assert.equal(run.stdout.replaceAll('\r\n', '\n'), 'alpha\nbeta\n');
  assert.equal(run.stderr.replaceAll('\r\n', '\n'), 'fake: done\n');
  assert.deepEqual(fakeCalls(home, 'gh'), [['alpha', 'beta']]);
});
