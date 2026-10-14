/**
 * The sandbox home command, `node scripts/dev-home.ts`, as a contributor runs
 * it on Linux and on Windows.
 *
 * Each case gives the script a fake real home and a sandbox under the
 * temporary root, so the script can never reach the home of the person who
 * runs the suite. The script is driven as a subprocess with no shell, like
 * the CLI it wraps.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT, type Run, testRoot } from './helpers/nexus.ts';

/** The script under test. */
const DEV_HOME = join(REPO_ROOT, 'scripts', 'dev-home.ts');

/** A fresh directory under the temporary root, for one case. */
function scene(name: string): { readonly real: string; readonly sandbox: string } {
  const root = join(testRoot(), `dev-home-${name}`);
  const real = join(root, 'real');
  mkdirSync(real, { recursive: true });
  return { real, sandbox: join(root, 'sandbox') };
}

/** Run the script with `real` as the person's home and `sandbox` as the sandbox. */
function devHome(real: string, sandbox: string, args: readonly string[]): Run {
  const result = spawnSync(process.execPath, [DEV_HOME, ...args], {
    cwd: real,
    env: { ...process.env, HOME: real, USERPROFILE: real, NEXUS_DEV_HOME: sandbox },
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('the sandbox home command runs the CLI against a sandbox it builds', () => {
  const { real, sandbox } = scene('list');
  const run = devHome(real, sandbox, ['list']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^nexus-setup\tcontrol\t-\t-\t-$/m);
  assert.ok(run.stderr.startsWith(`dev-home: HOME=${sandbox}\n`), run.stderr);
  assert.ok(existsSync(join(sandbox, '.nexus-dev-home')));
  assert.equal(
    readFileSync(join(sandbox, '.nexus', 'skills', 'nexus-link', 'SKILL.md'), 'utf8'),
    readFileSync(join(REPO_ROOT, 'skills', 'nexus-link', 'SKILL.md'), 'utf8'),
  );
  for (const root of ['.claude', '.codex', '.custom-skills', '.agents']) {
    assert.ok(existsSync(join(sandbox, root)), root);
  }
  assert.ok(!existsSync(join(real, '.nexus')), 'the real home was touched');
});

test('bootstrap through the sandbox home command links the control skills in the sandbox', () => {
  const { real, sandbox } = scene('bootstrap');
  const run = devHome(real, sandbox, ['bootstrap']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'nexus: bootstrap complete: control skills linked\n');
  for (const agent of ['.claude', '.codex']) {
    assert.ok(existsSync(join(sandbox, agent, 'skills', 'nexus-setup', 'SKILL.md')), agent);
  }
  assert.ok(!existsSync(join(real, '.claude')), 'the real home was touched');
});

test('the sandbox home command gives the CLI exit code back', () => {
  const { real, sandbox } = scene('refusal');
  const run = devHome(real, sandbox, ['bogus']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^Usage: nexus </m);
});

test('the sandbox home command refuses a sandbox that holds the real home', () => {
  // The person's home is `inner`; the sandbox is that home, then its parent.
  const { real } = scene('holds-real');
  const inner = join(real, 'inner');
  mkdirSync(inner);
  for (const sandbox of [inner, real]) {
    const run = devHome(inner, sandbox, ['list']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^dev-home: error: the sandbox home may not hold your real home: /);
    assert.equal(run.stdout, '');
  }
  assert.ok(!existsSync(join(real, '.nexus-dev-home')));
});

test('reset deletes only a sandbox the command marked as its own', () => {
  const { real, sandbox } = scene('reset');
  mkdirSync(sandbox);
  writeFileSync(join(sandbox, 'keep'), 'mine\n');
  const refused = devHome(real, sandbox, ['--reset', 'list']);
  assert.equal(refused.status, 1);
  assert.equal(
    refused.stderr,
    `dev-home: error: ${sandbox} has no .nexus-dev-home marker, ` +
      'so it is not a sandbox this script made\n',
  );
  assert.equal(readFileSync(join(sandbox, 'keep'), 'utf8'), 'mine\n');

  const { sandbox: marked } = scene('reset-marked');
  assert.equal(devHome(real, marked, ['list']).status, 0);
  writeFileSync(join(marked, 'leftover'), 'old\n');
  const reset = devHome(real, marked, ['--reset']);
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal(reset.stdout, `dev-home: ${marked}\n`);
  assert.ok(!existsSync(join(marked, 'leftover')));
  assert.ok(existsSync(join(marked, '.nexus-dev-home')));
});

test('with no CLI arguments the sandbox home command names the sandbox and shows its usage', () => {
  const { real, sandbox } = scene('bare');
  const run = devHome(real, sandbox, []);
  assert.equal(run.status, 2);
  assert.equal(run.stdout, `dev-home: ${sandbox}\n`);
  assert.match(run.stderr, /^Usage: node scripts\/dev-home\.ts /);
  const help = devHome(real, sandbox, ['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stdout, run.stderr);
});

test('an empty NEXUS_DEV_HOME means the default sandbox in the repository', () => {
  // A real home inside the default sandbox makes the command refuse it by
  // name, so the case proves the default without building anything there.
  const real = join(REPO_ROOT, '.scratch', 'home', 'a-home-that-is-not-there');
  const result = spawnSync(process.execPath, [DEV_HOME, 'list'], {
    cwd: testRoot(),
    env: { ...process.env, HOME: real, USERPROFILE: real, NEXUS_DEV_HOME: '' },
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'dev-home: error: the sandbox home may not hold your real home: ' +
      `${join(physicalRepo(), '.scratch', 'home')}\n`,
  );
  assert.ok(!existsSync(real));
});

/** The repository's physical path, as the command resolves it. */
function physicalRepo(): string {
  return realpathSync.native(REPO_ROOT);
}
