/**
 * `nexus bootstrap`: link the eight Control Skills into both Native Skill
 * Roots, and nothing else. It runs no Setup, reads no lock and installs
 * nothing.
 *
 * These are the bootstrap cases of the Bash suite, carried over. The case that
 * needs a
 * fault point (`bootstrap_staging_failure`) is in `faults.test.ts`, and the
 * forced replacement only Setup makes is in `setup.test.ts`
 * (`force_replacement`) and `faults.test.ts` (`force_recovery`).
 *
 * Every other case runs on Windows too, where each Managed Link is a junction
 * (ADR 0010) and the links a case starts with are junctions as well.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { customHome, writeLock, writeSkill } from './helpers/homes.ts';
import {
  agentTrees,
  assertLinkText,
  assertLinkTo,
  isAbsent,
  linkText,
  makeLink,
} from './helpers/links.ts';
import { newHome, runNexus } from './helpers/nexus.ts';

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
  'bootstrap links every Control Skill into both agents, and a second run changes nothing',
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
    for (const path of [
      '.claude/commands/nexus',
      '.nexus/skill-lock.json',
      '.claude-backup',
      '.codex-backup',
    ]) {
      assert.ok(isAbsent(join(home, path)), path);
    }

    const before = agentTrees(home);
    const again = runNexus(home, ['bootstrap']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(agentTrees(home), before);
  },
);

test(
  'a Foreign Entry at a Control Skill is a Collision; it is kept and the rest are linked',
  () => {
    const home = newHome('collision');
    mkdirSync(join(home, '.claude', 'skills', 'nexus-setup'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'nexus-setup', 'marker'), 'preserve\n');
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
    makeLink('/external/target', join(home, '.codex', 'skills', 'nexus-link'));

    const run = runNexus(home, ['bootstrap']);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(
      run.stderr,
      `nexus: error: collision at ${join(home, '.claude', 'skills', 'nexus-setup')}\n` +
        `nexus: error: collision at ${join(home, '.codex', 'skills', 'nexus-link')} ` +
        '(external symlink)\n' +
        'nexus: error: bootstrap failed with 2 error(s)\n',
    );
    assert.equal(
      readFileSync(join(home, '.claude', 'skills', 'nexus-setup', 'marker'), 'utf8'),
      'preserve\n',
    );
    assertLinkText(join(home, '.codex', 'skills', 'nexus-link'), '/external/target');
    assertLinkTo(
      join(home, '.claude', 'skills', 'nexus-link'),
      join(home, '.nexus', 'skills', 'nexus-link'),
    );
    assertLinkTo(
      join(home, '.codex', 'skills', 'nexus-setup'),
      join(home, '.nexus', 'skills', 'nexus-setup'),
    );
  },
);

test('NEXUS_TEST_FORCE does not let bootstrap replace a Foreign Entry', () => {
  const home = newHome('force_env_ignored');
  mkdirSync(join(home, '.claude', 'skills', 'nexus-setup'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'nexus-setup', 'marker'), 'protected\n');
  const run = runNexus(home, ['bootstrap'], { env: { NEXUS_TEST_FORCE: 'true' } });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('collision'));
  assert.equal(
    readFileSync(join(home, '.claude', 'skills', 'nexus-setup', 'marker'), 'utf8'),
    'protected\n',
  );
});

test(
  'a Managed Link that reaches its Owner only lexically, through a link elsewhere, is repointed',
  () => {
    const home = newHome('lexical_managed');
    makeLink('/external/target', join(home, '.nexus', 'skills', 'alias'));
    const link = join(home, '.claude', 'skills', 'nexus-setup');
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    makeLink('../../.nexus/skills/alias/nexus-setup', link);

    const run = runNexus(home, ['bootstrap']);
    assert.equal(run.status, 0, run.stderr);
    assertLinkTo(link, join(home, '.nexus', 'skills', 'nexus-setup'));
    assert.notEqual(linkText(link), '../../.nexus/skills/alias/nexus-setup');
  },
);

test('a Managed Link into a symlinked Owner root is repointed to the right skill', () => {
  const home = newHome('symlinked_root');
  renameSync(join(home, '.nexus', 'skills'), join(home, '.nexus', 'skills-real'));
  makeLink('skills-real', join(home, '.nexus', 'skills'));
  const link = join(home, '.claude', 'skills', 'nexus-setup');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  makeLink(join(home, '.nexus', 'skills-real', 'nexus-link'), link);

  const run = runNexus(home, ['bootstrap']);
  assert.equal(run.status, 0, run.stderr);
  assertLinkTo(link, join(home, '.nexus', 'skills', 'nexus-setup'));
});

test('bootstrap never links the Instruction Paths, even when GLOBAL.md is there', () => {
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
  assertLinkTo(
    join(home, '.claude', 'skills', 'nexus-link'),
    join(home, '.nexus', 'skills', 'nexus-link'),
  );
});

test('a Control Skill with no Owner directory is a missing link target', () => {
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
