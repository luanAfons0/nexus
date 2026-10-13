/**
 * `nexus bootstrap`: link the eight Control Skills into both Native Skill
 * Roots, and nothing else. It runs no Setup, reads no lock and installs
 * nothing.
 *
 * These are the bootstrap cases of `tests/run.sh` and of
 * `tests/cases/global-instructions.sh`, carried over. The case that needs a
 * fault point (`bootstrap_staging_failure`) waits for #82, and the cases of
 * the forced replacement only Setup uses (`force_replacement`,
 * `force_recovery`) wait for #81 and #82. On Linux the same homes also run
 * through the Bash CLI, and the bytes and the trees are compared.
 *
 * On Windows Bootstrap needs junctions (#76); until then it refuses with one
 * sentence, and these cases skip.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { customHome, writeLock, writeSkill } from './helpers/homes.ts';
import {
  agentTrees,
  assertLinkTo,
  isAbsent,
  linkText,
  runBash,
  withoutToolNoise,
} from './helpers/links.ts';
import { newHome, runNexus } from './helpers/nexus.ts';

const WINDOWS = process.platform === 'win32';
const ON_WINDOWS = WINDOWS && 'Bootstrap on Windows makes junctions, which is #76';

const CONTROL_SKILLS = [
  'nexus-setup',
  'nexus-link',
  'nexus-install',
  'nexus-new',
  'nexus-help',
  'nexus-update',
  'nexus-remove',
  'nexus',
];

test(
  'bootstrap links every Control Skill into both Native Skill Roots, and a second run changes nothing',
  { skip: ON_WINDOWS },
  () => {
    const home = newHome('bootstrap');
    const run = runNexus(home, ['bootstrap']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'nexus: bootstrap complete: control skills linked\n');
    assert.equal(run.stderr, '');
    for (const name of CONTROL_SKILLS) {
      assertLinkTo(join(home, '.claude', 'skills', name), join(home, '.nexus', 'skills', name));
      assertLinkTo(join(home, '.codex', 'skills', name), join(home, '.nexus', 'skills', name));
    }
    for (const path of ['.claude/commands/nexus', '.nexus/skill-lock.json', '.claude-backup', '.codex-backup']) {
      assert.ok(isAbsent(join(home, path)), path);
    }

    const before = agentTrees(home);
    const again = runNexus(home, ['bootstrap']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(agentTrees(home), before);
  },
);

test('a Foreign Entry at a Control Skill is a Collision; it is kept and the rest are linked', { skip: ON_WINDOWS }, () => {
  const home = newHome('collision');
  mkdirSync(join(home, '.claude', 'skills', 'nexus-setup'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'nexus-setup', 'marker'), 'preserve\n');
  mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
  symlinkSync('/external/target', join(home, '.codex', 'skills', 'nexus-link'));

  const run = runNexus(home, ['bootstrap']);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(
    run.stderr,
    `nexus: error: collision at ${join(home, '.claude', 'skills', 'nexus-setup')}\n` +
      `nexus: error: collision at ${join(home, '.codex', 'skills', 'nexus-link')} (external symlink)\n` +
      'nexus: error: bootstrap failed with 2 error(s)\n',
  );
  assert.equal(readFileSync(join(home, '.claude', 'skills', 'nexus-setup', 'marker'), 'utf8'), 'preserve\n');
  assert.equal(linkText(join(home, '.codex', 'skills', 'nexus-link')), '/external/target');
  assertLinkTo(join(home, '.claude', 'skills', 'nexus-link'), join(home, '.nexus', 'skills', 'nexus-link'));
  assertLinkTo(join(home, '.codex', 'skills', 'nexus-setup'), join(home, '.nexus', 'skills', 'nexus-setup'));
});

test('NEXUS_TEST_FORCE does not let bootstrap replace a Foreign Entry', { skip: ON_WINDOWS }, () => {
  const home = newHome('force_env_ignored');
  mkdirSync(join(home, '.claude', 'skills', 'nexus-setup'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'nexus-setup', 'marker'), 'protected\n');
  const run = runNexus(home, ['bootstrap'], { env: { NEXUS_TEST_FORCE: 'true' } });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('collision'));
  assert.equal(readFileSync(join(home, '.claude', 'skills', 'nexus-setup', 'marker'), 'utf8'), 'protected\n');
});

test(
  'a Managed Link that reaches its Owner only lexically, through a link elsewhere, is repointed',
  { skip: ON_WINDOWS },
  () => {
    const home = newHome('lexical_managed');
    symlinkSync('/external/target', join(home, '.nexus', 'skills', 'alias'));
    const link = join(home, '.claude', 'skills', 'nexus-setup');
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync('../../.nexus/skills/alias/nexus-setup', link);

    const run = runNexus(home, ['bootstrap']);
    assert.equal(run.status, 0, run.stderr);
    assertLinkTo(link, join(home, '.nexus', 'skills', 'nexus-setup'));
    assert.notEqual(linkText(link), '../../.nexus/skills/alias/nexus-setup');
  },
);

test('a Managed Link into a symlinked Owner root is repointed to the right skill', { skip: ON_WINDOWS }, () => {
  const home = newHome('symlinked_root');
  renameSync(join(home, '.nexus', 'skills'), join(home, '.nexus', 'skills-real'));
  symlinkSync('skills-real', join(home, '.nexus', 'skills'));
  const link = join(home, '.claude', 'skills', 'nexus-setup');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(join(home, '.nexus', 'skills-real', 'nexus-link'), link);

  const run = runNexus(home, ['bootstrap']);
  assert.equal(run.status, 0, run.stderr);
  assertLinkTo(link, join(home, '.nexus', 'skills', 'nexus-setup'));
});

test('bootstrap never links the Instruction Paths, even when GLOBAL.md is there', { skip: ON_WINDOWS }, () => {
  const home = customHome('global_bootstrap');
  writeSkill(join(home, '.agents', 'skills'), 'installed');
  writeSkill(join(home, '.custom-skills'), 'mine');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['installed']);
  writeFileSync(join(home, '.custom-skills', 'GLOBAL.md'), 'rule one\n');

  const run = runNexus(home, ['bootstrap']);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(isAbsent(join(home, '.claude', 'CLAUDE.md')));
  assert.ok(isAbsent(join(home, '.codex', 'AGENTS.md')));
  assert.ok(isAbsent(join(home, '.claude', 'skills', 'mine')));
  assert.ok(isAbsent(join(home, '.claude', 'skills', 'installed')));
  assertLinkTo(join(home, '.claude', 'skills', 'nexus-link'), join(home, '.nexus', 'skills', 'nexus-link'));
});

test('a Control Skill with no Owner directory is a missing link target', { skip: ON_WINDOWS }, () => {
  const home = newHome('bootstrap_missing_owner');
  const owner = join(home, '.nexus', 'skills', 'nexus-help');
  renameSync(owner, join(home, 'moved'));
  const run = runNexus(home, ['bootstrap']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    `nexus: error: missing link target: ${owner}\n`.repeat(2) +
      'nexus: error: bootstrap failed with 2 error(s)\n',
  );
  assertLinkTo(join(home, '.codex', 'skills', 'nexus'), join(home, '.nexus', 'skills', 'nexus'));
});

test(
  'bootstrap says the same bytes and leaves the same trees as the Bash CLI',
  { skip: WINDOWS && 'the Bash CLI runs on Linux alone' },
  () => {
    const scenes: Record<string, (home: string) => void> = {
      fresh: () => undefined,
      collisions: (home) => {
        mkdirSync(join(home, '.claude', 'skills', 'nexus-setup', 'inner'), { recursive: true });
        writeFileSync(join(home, '.codex', 'skills', 'nexus'), 'file\n');
        symlinkSync('/external/target', join(home, '.codex', 'skills', 'nexus-link'));
        symlinkSync('../../.agents/skills/old', join(home, '.claude', 'skills', 'nexus-new'));
        symlinkSync('../../.nexus/skills/nexus-help', join(home, '.claude', 'skills', 'nexus-update'));
      },
      'missing-owner': (home) => renameSync(join(home, '.nexus', 'skills', 'nexus-help'), join(home, 'moved')),
      'bad-lock': (home) => writeFileSync(join(home, '.nexus', 'skill-lock.json'), '{bad'),
    };
    for (const [name, fill] of Object.entries(scenes)) {
      const bash = customHome(`bootstrap-bash-${name}`);
      const node = customHome(`bootstrap-node-${name}`);
      fill(bash);
      fill(node);
      for (const round of [1, 2]) {
        const expected = runBash(bash, ['bootstrap']);
        const actual = runNexus(node, ['bootstrap']);
        const label = `${name}, run ${round}`;
        const same = (text: string, home: string) => text.replaceAll(home, '<home>');
        assert.equal(actual.status, expected.status, label);
        assert.equal(same(actual.stdout, node), same(expected.stdout, bash), label);
        assert.equal(same(actual.stderr, node), same(withoutToolNoise(expected.stderr), bash), label);
        assert.equal(same(agentTrees(node), node), same(agentTrees(bash), bash), label);
      }
    }
  },
);

test(
  'on Windows bootstrap refuses with one sentence until it has junctions',
  { skip: !WINDOWS && 'the refusal is for Windows alone' },
  () => {
    const home = newHome('bootstrap_windows');
    const run = runNexus(home, ['bootstrap']);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(
      run.stderr,
      'nexus: error: bootstrap does not run on Windows yet; run Nexus inside WSL for now\n',
    );
    assert.ok(isAbsent(join(home, '.claude')));
  },
);
