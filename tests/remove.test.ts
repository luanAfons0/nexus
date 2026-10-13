/**
 * `nexus remove <name>`: run `npx skills remove` through a fake `npx`,
 * Publish the Upstream Lock it wrote, and link.
 *
 * These are the cases of `tests/cases/remove.sh`, carried over. No case
 * reaches the network: the fake `npx` deletes from the Canonical Root and the
 * Upstream Lock as upstream would. On Linux the same homes also run through
 * the Bash CLI, and the bytes are compared, because the Bash CLI is the
 * specification.
 *
 * A home starts reconciled by a real `nexus link`, and a case that ends in a
 * link skips on Windows until Link has junctions and Managed Copies (#76).
 * Until then a Windows home starts unlinked: every refusal before the link
 * runs there too, and there the fake is found as `npx.cmd`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { customHome, snapshotTree, writeLock, writeSkill } from './helpers/homes.ts';
import {
  agentTrees,
  assertLinkTo,
  isAbsent,
  linkText,
  runBashWithFakes,
  withoutToolNoise,
} from './helpers/links.ts';
import { fakeCalls, installFake, runNexus } from './helpers/nexus.ts';

const WINDOWS = process.platform === 'win32';
const UNTIL_JUNCTIONS = WINDOWS && 'link refuses on Windows until it has junctions (#76)';

/** A home with `names` installed in both locks and the remove fake first on its PATH. */
function removeHome(name: string, names: readonly string[]): string {
  const home = customHome(name);
  installFake(home, 'npx', 'npx-remove.ts');
  for (const skill of names) writeSkill(join(home, '.agents', 'skills'), skill);
  writeLock(join(home, '.agents', '.skill-lock.json'), names);
  writeLock(join(home, '.nexus', 'skill-lock.json'), names);
  return home;
}

/**
 * A home with `alpha` and `beta` installed, entries Nexus does not own
 * planted in both Native Skill Roots, and links reconciled by a real
 * `nexus link`, as `remove_installed_home` makes it.
 */
function installedHome(name: string): string {
  const home = removeHome(name, ['alpha', 'beta']);
  mkdirSync(join(home, '.claude', 'skills', 'unrelated'));
  writeFileSync(join(home, '.claude', 'skills', 'unrelated', 'marker'), 'preserve\n');
  // A junction on Windows, which needs no privilege; it holds the absolute form.
  const external = join(home, '.codex', 'skills', 'external');
  if (WINDOWS) symlinkSync(resolve('/external/target'), external, 'junction');
  else symlinkSync('/external/target', external);
  if (!UNTIL_JUNCTIONS) {
    const link = runNexus(home, ['link']);
    assert.equal(link.status, 0, link.stderr);
  }
  return home;
}

/** Every install or lock scratch entry left in the Nexus home. */
function scratch(home: string): readonly string[] {
  return readdirSync(join(home, '.nexus')).filter(
    (name) => name.startsWith('.nexus-install-') || name.startsWith('.nexus-lock.'),
  );
}

/** The bytes of the Nexus Lock. */
function nexusLock(home: string): Buffer {
  return readFileSync(join(home, '.nexus', 'skill-lock.json'));
}

/** The bytes of the Upstream Lock. */
function upstreamLock(home: string): Buffer {
  return readFileSync(join(home, '.agents', '.skill-lock.json'));
}

test(
  'remove runs npx skills remove, publishes the lock without the skill, and unlinks it alone',
  { skip: UNTIL_JUNCTIONS },
  () => {
    const home = installedHome('remove-happy');
    const run = runNexus(home, ['remove', 'alpha'], { env: { XDG_STATE_HOME: 'state' } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.ok(
      run.stdout.endsWith(
        `nexus: removed alpha: Claude ${join(home, '.claude', 'skills', 'alpha')} and ` +
          `Codex ${join(home, '.codex', 'skills', 'alpha')} links reconciled\n`,
      ),
      run.stdout,
    );
    assert.deepEqual(fakeCalls(home, 'npx'), [
      ['--yes', 'skills', 'remove', 'alpha', '--global', '--yes'],
    ]);
    assert.ok(isAbsent(join(home, '.claude', 'skills', 'alpha')));
    assert.ok(isAbsent(join(home, '.codex', 'skills', 'alpha')));
    const canonical = join(home, '.agents', 'skills');
    assertLinkTo(join(home, '.claude', 'skills', 'beta'), join(canonical, 'beta'));
    assertLinkTo(join(home, '.codex', 'skills', 'beta'), join(canonical, 'beta'));
    assertLinkTo(
      join(home, '.claude', 'skills', 'nexus-remove'),
      join(home, '.nexus', 'skills', 'nexus-remove'),
    );
    assert.deepEqual(nexusLock(home), upstreamLock(home));
    assert.ok(!nexusLock(home).toString().includes('"alpha"'));
    assert.equal(
      readFileSync(join(home, '.claude', 'skills', 'unrelated', 'marker'), 'utf8'),
      'preserve\n',
    );
    assert.equal(linkText(join(home, '.codex', 'skills', 'external')), '/external/target');
    assert.deepEqual(scratch(home), []);
  },
);

test('remove refuses a bad, custom or uninstalled name before npx, and keeps the lock', () => {
  const home = installedHome('remove-refusals');
  writeSkill(join(home, '.custom-skills'), 'mine');
  const before = nexusLock(home);
  const cases: readonly (readonly [readonly string[], number, string])[] = [
    [[], 2, 'remove requires exactly one skill name'],
    [['alpha', 'beta'], 2, 'remove requires exactly one skill name'],
    [['--all'], 2, 'remove requires a safe skill name: --all'],
    [['../escape'], 2, 'remove requires a safe skill name: ../escape'],
    [['nexus-link'], 2, 'reserved control skill name: nexus-link'],
    [
      ['mine'],
      1,
      `remove refuses a custom skill: mine; delete ${join(home, '.custom-skills', 'mine')} ` +
        'yourself and run link',
    ],
    [['ghost'], 1, 'skill is not installed: ghost'],
  ];
  for (const [args, status, sentence] of cases) {
    // A PATH with no npx at all, so a refusal that reached upstream would show.
    const run = runNexus(home, ['remove', ...args], {
      env: { PATH: '', NVM_DIR: join(home, '.no-nvm') },
    });
    assert.equal(run.status, status, JSON.stringify(args));
    assert.equal(run.stdout, '', JSON.stringify(args));
    assert.equal(run.stderr, `nexus: error: ${sentence}\n`, JSON.stringify(args));
  }
  assert.equal(
    readFileSync(join(home, '.custom-skills', 'mine', 'SKILL.md'), 'utf8'),
    '---\nname: mine\n---\n',
  );
  assert.deepEqual(fakeCalls(home, 'npx'), []);
  assert.deepEqual(nexusLock(home), before);
});

test(
  'remove of the last Installed Skill Publishes a lock that selects no skills',
  { skip: UNTIL_JUNCTIONS },
  () => {
    const home = removeHome('remove-last', ['alpha']);
    assert.equal(runNexus(home, ['link']).status, 0);
    const run = runNexus(home, ['remove', 'alpha']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /nexus: removed alpha: /);
    const lock = JSON.parse(nexusLock(home).toString()) as { skills: unknown };
    assert.deepEqual(lock.skills, {});
    assert.ok(isAbsent(join(home, '.claude', 'skills', 'alpha')));
    assert.ok(isAbsent(join(home, '.codex', 'skills', 'alpha')));
    assertLinkTo(
      join(home, '.claude', 'skills', 'nexus-remove'),
      join(home, '.nexus', 'skills', 'nexus-remove'),
    );
  },
);

test('a failed npx remove keeps the Nexus Lock and the links, and exits with its status', () => {
  const home = installedHome('remove-upstream-failure');
  const before = nexusLock(home);
  const trees = agentTrees(home);
  const run = runNexus(home, ['remove', 'alpha'], { env: { NEXUS_FAKE_NPX_MODE: 'failure' } });
  assert.equal(run.status, 42);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'nexus: error: upstream skill removal failed (status 42)\n');
  assert.deepEqual(nexusLock(home), before);
  assert.equal(agentTrees(home), trees);
  if (!UNTIL_JUNCTIONS) {
    const canonical = join(home, '.agents', 'skills', 'alpha');
    assertLinkTo(join(home, '.claude', 'skills', 'alpha'), canonical);
    assertLinkTo(join(home, '.codex', 'skills', 'alpha'), canonical);
  }
});

test('an Upstream Lock that still names the skill is not Published, and no link moves', () => {
  const home = installedHome('remove-still-present');
  const before = nexusLock(home);
  const links = [snapshotTree(join(home, '.claude')), snapshotTree(join(home, '.codex'))];
  const run = runNexus(home, ['remove', 'alpha'], { env: { NEXUS_FAKE_NPX_MODE: 'keep' } });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'nexus: error: upstream lock still contains alpha\n');
  assert.deepEqual(nexusLock(home), before);
  assert.deepEqual(
    [snapshotTree(join(home, '.claude')), snapshotTree(join(home, '.codex'))],
    links,
  );
  assert.deepEqual(scratch(home), []);
});

test(
  'a canonical directory upstream left behind is named and kept',
  { skip: UNTIL_JUNCTIONS },
  () => {
    const home = installedHome('remove-untracked');
    const run = runNexus(home, ['remove', 'alpha'], {
      env: { NEXUS_FAKE_NPX_MODE: 'leave_directory' },
    });
    assert.equal(run.status, 0, run.stderr);
    const canonical = join(home, '.agents', 'skills', 'alpha');
    assert.match(run.stdout, new RegExp(`untracked canonical skill directory: ${escape(canonical)}\n`));
    assert.equal(readFileSync(join(canonical, 'SKILL.md'), 'utf8'), '---\nname: alpha\n---\n');
    assert.ok(isAbsent(join(home, '.claude', 'skills', 'alpha')));
    assert.ok(isAbsent(join(home, '.codex', 'skills', 'alpha')));
    assert.deepEqual(nexusLock(home), upstreamLock(home));
  },
);

test(
  'remove says the same bytes and leaves the same files as the Bash CLI',
  { skip: WINDOWS && 'the Bash CLI runs on Linux alone' },
  () => {
    type Scene = {
      readonly args: readonly string[];
      readonly mode?: string;
      readonly names?: readonly string[];
      readonly fill?: (home: string) => void;
    };
    const scenes: Readonly<Record<string, Scene>> = {
      success: { args: ['alpha'] },
      last: { args: ['alpha'], names: ['alpha'] },
      failure: { args: ['alpha'], mode: 'failure' },
      keep: { args: ['alpha'], mode: 'keep' },
      leave_directory: { args: ['alpha'], mode: 'leave_directory' },
      none: { args: [] },
      two: { args: ['alpha', 'beta'] },
      flag: { args: ['--all'] },
      unsafe: { args: ['../escape'] },
      control: { args: ['nexus-link'] },
      custom: {
        args: ['mine'],
        fill: (home) => writeSkill(join(home, '.custom-skills'), 'mine'),
      },
      'not-installed': { args: ['ghost'] },
      'link-fault': {
        args: ['alpha'],
        fill: (home) => writeSkill(join(home, '.codex', 'skills'), 'beta'),
      },
    };
    for (const [name, scene] of Object.entries(scenes)) {
      const bash = removeHome(`remove-bash-${name}`, scene.names ?? ['alpha', 'beta']);
      const node = removeHome(`remove-node-${name}`, scene.names ?? ['alpha', 'beta']);
      for (const home of [bash, node]) {
        assert.equal(runNexus(home, ['link']).status, 0, name);
        scene.fill?.(home);
      }
      const env: Readonly<Record<string, string>> =
        scene.mode === undefined ? {} : { NEXUS_FAKE_NPX_MODE: scene.mode };
      const expected = runBashWithFakes(bash, ['remove', ...scene.args], env);
      const actual = runNexus(node, ['remove', ...scene.args], { env });
      const same = (text: string, home: string) =>
        text
          .replaceAll(home, '<home>')
          .replace(/\.nexus-install-lock\.[A-Za-z0-9]{6}/g, '<snapshot>');
      assert.equal(actual.status, expected.status, name);
      assert.equal(same(actual.stdout, node), same(expected.stdout, bash), name);
      assert.equal(same(actual.stderr, node), same(withoutToolNoise(expected.stderr), bash), name);
      assert.equal(same(agentTrees(node), node), same(agentTrees(bash), bash), name);
      assert.deepEqual(nexusLock(node), nexusLock(bash), name);
      assert.deepEqual(scratch(node), scratch(bash), name);
      assert.deepEqual(fakeCalls(node, 'npx'), fakeCalls(bash, 'npx'), name);
    }
  },
);

/** `text` with every character a regular expression reads as syntax made plain. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
