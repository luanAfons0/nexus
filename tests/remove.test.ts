/**
 * `nexus remove <name>`: run `npx skills remove` through a fake `npx`,
 * Publish the Upstream Lock it wrote, and link.
 *
 * These are the remove cases of the Bash suite, carried over. No case
 * reaches the network: the fake `npx` deletes from the Canonical Root and the
 * Upstream Lock as upstream would.
 *
 * A home starts reconciled by a real `nexus link`. Every case runs on
 * Windows too, where the fake is found as `npx.cmd` and a link is a junction.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { customHome, snapshotTree, writeLock, writeSkill } from './helpers/homes.ts';
import { agentTrees, assertLinkText, assertLinkTo, isAbsent, makeLink } from './helpers/links.ts';
import { fakeCalls, installFake, runNexus } from './helpers/nexus.ts';

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
  makeLink('/external/target', join(home, '.codex', 'skills', 'external'));
  const link = runNexus(home, ['link']);
  assert.equal(link.status, 0, link.stderr);
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
    assertLinkText(join(home, '.codex', 'skills', 'external'), '/external/target');
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

test('remove of the last Installed Skill Publishes a lock that selects no skills', () => {
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
});

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
  const canonical = join(home, '.agents', 'skills', 'alpha');
  assertLinkTo(join(home, '.claude', 'skills', 'alpha'), canonical);
  assertLinkTo(join(home, '.codex', 'skills', 'alpha'), canonical);
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

test('a canonical directory upstream left behind is named and kept', () => {
  const home = installedHome('remove-untracked');
  const run = runNexus(home, ['remove', 'alpha'], {
    env: { NEXUS_FAKE_NPX_MODE: 'leave_directory' },
  });
  assert.equal(run.status, 0, run.stderr);
  const canonical = join(home, '.agents', 'skills', 'alpha');
  assert.match(
    run.stdout,
    new RegExp(`untracked canonical skill directory: ${escape(canonical)}\n`),
  );
  assert.equal(readFileSync(join(canonical, 'SKILL.md'), 'utf8'), '---\nname: alpha\n---\n');
  assert.ok(isAbsent(join(home, '.claude', 'skills', 'alpha')));
  assert.ok(isAbsent(join(home, '.codex', 'skills', 'alpha')));
  assert.deepEqual(nexusLock(home), upstreamLock(home));
});

/** `text` with every character a regular expression reads as syntax made plain. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
