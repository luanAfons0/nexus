/**
 * `nexus update <name>`: run `npx skills update` through a fake `npx`,
 * Publish the Upstream Lock it wrote, and link.
 *
 * These are the cases of `tests/cases/update.sh`, carried over. No case
 * reaches the network: the fake `npx` writes the Canonical Root and the
 * Upstream Lock as upstream would. On Linux the same homes also run through
 * the Bash CLI, and the bytes are compared, because the Bash CLI is the
 * specification.
 *
 * A case that ends in a link skips on Windows until Link has junctions and
 * Managed Copies (#76). Every refusal before the link runs on Windows too,
 * and there the fake is found as `npx.cmd`.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { customHome, writeLock, writeSkill } from './helpers/homes.ts';
import {
  agentTrees,
  assertLinkTo,
  runBashWithFakes,
  withoutToolNoise,
} from './helpers/links.ts';
import { fakeCalls, installFake, runNexus } from './helpers/nexus.ts';

const WINDOWS = process.platform === 'win32';
const UNTIL_JUNCTIONS = WINDOWS && 'link refuses on Windows until it has junctions (#76)';

/** The arguments `npx` gets for `update alpha`. */
const UPDATE_ALPHA = ['--yes', 'skills', 'update', 'alpha', '--global', '--yes'];

/** A home with `alpha` installed in both locks and the update fake first on its PATH. */
function updateHome(name: string): string {
  const home = customHome(name);
  installFake(home, 'npx', 'npx-update.ts');
  writeSkill(join(home, '.agents', 'skills'), 'alpha');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['alpha']);
  return home;
}

/** Every install scratch file left in the Nexus home. */
function scratch(home: string): readonly string[] {
  return readdirSync(join(home, '.nexus')).filter((name) => name.startsWith('.nexus-install-'));
}

/** The bytes of the Nexus Lock. */
function nexusLock(home: string): Buffer {
  return readFileSync(join(home, '.nexus', 'skill-lock.json'));
}

/** The bytes of the Nexus Lock, or undefined when there is none. */
function lockOrNone(home: string): Buffer | undefined {
  return existsSync(join(home, '.nexus', 'skill-lock.json')) ? nexusLock(home) : undefined;
}

test(
  'update runs npx skills update, publishes the Upstream Lock, links, and says both hashes',
  { skip: UNTIL_JUNCTIONS },
  () => {
    const home = updateHome('update-happy');
    const canonical = join(home, '.agents', 'skills', 'alpha');
    const said = (from: string) =>
      `nexus: updated alpha: hash ${from} -> hash-new; canonical ${canonical}; ` +
      `Claude ${join(home, '.claude', 'skills', 'alpha')}; ` +
      `Codex ${join(home, '.codex', 'skills', 'alpha')}\n`;

    const run = runNexus(home, ['update', 'alpha'], { env: { XDG_STATE_HOME: 'state' } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.ok(run.stdout.endsWith(`nexus: link complete: skills reconciled\n${said('test-hash')}`));
    assert.deepEqual(fakeCalls(home, 'npx'), [UPDATE_ALPHA]);
    assert.deepEqual(nexusLock(home), readFileSync(join(home, '.agents', '.skill-lock.json')));
    assertLinkTo(join(home, '.claude', 'skills', 'alpha'), canonical);
    assertLinkTo(join(home, '.codex', 'skills', 'alpha'), canonical);
    assert.deepEqual(scratch(home), []);

    // A repeated update with an unchanged hash still says both sides.
    const again = runNexus(home, ['update', 'alpha']);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(again.stdout.endsWith(said('hash-new')));
  },
);

test('update refuses a bad, custom or uninstalled name before npx, and keeps the lock', () => {
  const home = updateHome('update-refusals');
  writeSkill(join(home, '.custom-skills'), 'mine');
  const before = nexusLock(home);
  const cases: readonly (readonly [readonly string[], number, string])[] = [
    [[], 2, 'update requires exactly one skill name'],
    [['alpha', 'beta'], 2, 'update requires exactly one skill name'],
    [['--all'], 2, 'update requires a safe skill name'],
    [['../x'], 2, 'update requires a safe skill name'],
    [[''], 2, 'update requires a safe skill name'],
    [['nexus-link'], 2, 'reserved control skill name: nexus-link'],
    [
      ['mine'],
      1,
      `update refuses a custom skill: mine (${join(home, '.custom-skills', 'mine')}); ` +
        'pull it in the custom root and run link',
    ],
    [['gamma'], 1, 'skill is not installed: gamma'],
  ];
  for (const [args, status, sentence] of cases) {
    const run = runNexus(home, ['update', ...args]);
    assert.equal(run.status, status, JSON.stringify(args));
    assert.equal(run.stdout, '', JSON.stringify(args));
    assert.equal(run.stderr, `nexus: error: ${sentence}\n`, JSON.stringify(args));
  }
  assert.deepEqual(fakeCalls(home, 'npx'), []);
  assert.deepEqual(nexusLock(home), before);

  // With no npx anywhere, the refusal still comes first and names no npx.
  rmSync(join(home, 'fakebin'), { recursive: true });
  const run = runNexus(home, ['update', 'mine'], {
    env: { PATH: '', NVM_DIR: join(home, '.no-nvm') },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /update refuses a custom skill: mine/);
  assert.ok(!run.stderr.includes('npx'));
});

test('update refuses without a Nexus Lock, and with a malformed Custom Root', () => {
  const home = updateHome('update-no-lock');
  rmSync(join(home, '.nexus', 'skill-lock.json'));
  const run = runNexus(home, ['update', 'alpha']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    'nexus: error: invalid version-3 lock: expected regular file at ' +
      `${join(home, '.nexus', 'skill-lock.json')}\n`,
  );

  rmSync(join(home, '.custom-skills'), { recursive: true });
  writeFileSync(join(home, '.custom-skills'), '');
  const custom = runNexus(home, ['update', 'alpha']);
  assert.equal(custom.status, 1);
  assert.equal(
    custom.stderr,
    'nexus: error: custom skill root must be a physical directory: ' +
      `${join(home, '.custom-skills')}\n`,
  );
  assert.deepEqual(fakeCalls(home, 'npx'), []);
});

test('a failed npx update keeps the Nexus Lock and exits with its status', () => {
  const home = updateHome('update-upstream-failure');
  const before = nexusLock(home);
  const run = runNexus(home, ['update', 'alpha'], { env: { NEXUS_FAKE_NPX_MODE: 'failure' } });
  assert.equal(run.status, 42);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'nexus: error: upstream skill update failed (status 42)\n');
  assert.deepEqual(nexusLock(home), before);
});

test('an Upstream Lock that lost the skill, is invalid, or lacks a SKILL.md is not Published', () => {
  const cases: Readonly<Record<string, (home: string) => RegExp | string>> = {
    drops_name: () => 'nexus: error: upstream lock no longer contains alpha\n',
    invalid_lock: () =>
      /\nnexus: error: upstream did not produce a valid version-3 skill lock\n$/,
    missing_skill_md: (home) =>
      'nexus: error: upstream lock skill is missing SKILL.md: ' +
      `${join(home, '.agents', 'skills', 'alpha', 'SKILL.md')}\n`,
  };
  for (const [mode, expected] of Object.entries(cases)) {
    const home = updateHome(`update-${mode}`);
    writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
    const before = nexusLock(home);
    const run = runNexus(home, ['update', 'alpha'], { env: { NEXUS_FAKE_NPX_MODE: mode } });
    assert.equal(run.status, 1, mode);
    assert.equal(run.stdout, '', mode);
    const sentence = expected(home);
    if (typeof sentence === 'string') assert.equal(run.stderr, sentence, mode);
    else assert.match(run.stderr, sentence, mode);
    assert.deepEqual(nexusLock(home), before, mode);
    assert.deepEqual(scratch(home), [], mode);
  }
});

test(
  'update says the same bytes and leaves the same files as the Bash CLI',
  { skip: WINDOWS && 'the Bash CLI runs on Linux alone' },
  () => {
    type Scene = {
      readonly args: readonly string[];
      readonly mode?: string;
      readonly fill?: (home: string) => void;
    };
    const scenes: Readonly<Record<string, Scene>> = {
      success: { args: ['alpha'] },
      failure: { args: ['alpha'], mode: 'failure' },
      drops_name: { args: ['alpha'], mode: 'drops_name' },
      invalid_lock: { args: ['alpha'], mode: 'invalid_lock' },
      missing_skill_md: { args: ['alpha'], mode: 'missing_skill_md' },
      none: { args: [] },
      two: { args: ['alpha', 'beta'] },
      unsafe: { args: ['../x'] },
      control: { args: ['nexus-link'] },
      custom: {
        args: ['mine'],
        fill: (home) => writeSkill(join(home, '.custom-skills'), 'mine'),
      },
      'not-installed': { args: ['gamma'] },
      'no-lock': {
        args: ['alpha'],
        fill: (home) => rmSync(join(home, '.nexus', 'skill-lock.json')),
      },
      'link-fault': {
        args: ['alpha'],
        fill: (home) => writeSkill(join(home, '.claude', 'skills'), 'alpha'),
      },
    };
    for (const [name, scene] of Object.entries(scenes)) {
      const bash = updateHome(`update-bash-${name}`);
      const node = updateHome(`update-node-${name}`);
      for (const home of [bash, node]) {
        writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
        scene.fill?.(home);
      }
      const env: Readonly<Record<string, string>> =
        scene.mode === undefined ? {} : { NEXUS_FAKE_NPX_MODE: scene.mode };
      const expected = runBashWithFakes(bash, ['update', ...scene.args], env);
      const actual = runNexus(node, ['update', ...scene.args], { env });
      const same = (text: string, home: string) =>
        text
          .replaceAll(home, '<home>')
          .replace(/\.nexus-install-lock\.[A-Za-z0-9]{6}/g, '<snapshot>');
      assert.equal(actual.status, expected.status, name);
      assert.equal(same(actual.stdout, node), same(expected.stdout, bash), name);
      assert.equal(same(actual.stderr, node), same(withoutToolNoise(expected.stderr), bash), name);
      assert.equal(same(agentTrees(node), node), same(agentTrees(bash), bash), name);
      assert.deepEqual(lockOrNone(node), lockOrNone(bash), name);
      assert.deepEqual(scratch(node), scratch(bash), name);
      assert.deepEqual(fakeCalls(node, 'npx'), fakeCalls(bash, 'npx'), name);
    }
  },
);
