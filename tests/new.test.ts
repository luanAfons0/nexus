/**
 * `nexus new <name>`: reserve one empty Custom Skill directory.
 *
 * This is `new_cli` of the Bash suite, carried over. `new` makes the
 * directory and names it; it does not link, because the skill has no
 * `SKILL.md` yet (the `nexus-new` Control Skill runs `nexus link` after the
 * skill is written). Nothing here links, so every case runs on Windows too.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { customHome, writeLock, writeSkill } from './helpers/homes.ts';
import { agentTrees, isAbsent } from './helpers/links.ts';
import { runNexus } from './helpers/nexus.ts';

/** A home with the Custom Root and one Installed Skill, `installed`. */
function newSkillHome(name: string): string {
  const home = customHome(name);
  writeSkill(join(home, '.agents', 'skills'), 'installed');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['installed']);
  return home;
}

test('new refuses a missing, extra, unsafe or Control Skill name with exit 2', () => {
  const home = newSkillHome('new-usage');
  const cases: readonly (readonly [readonly string[], string])[] = [
    [[], 'new requires exactly one skill name'],
    [['a', 'b'], 'new requires exactly one skill name'],
    [['../escape'], 'new requires a safe skill name'],
    [['--flag'], 'new requires a safe skill name'],
    [[''], 'new requires a safe skill name'],
    ...['nexus-link', 'nexus-help', 'nexus-update', 'nexus-remove', 'nexus'].map(
      (name) => [[name], `reserved control skill name: ${name}`] as const,
    ),
  ];
  const before = agentTrees(home);
  for (const [args, sentence] of cases) {
    const run = runNexus(home, ['new', ...args]);
    assert.equal(run.status, 2, JSON.stringify(args));
    assert.equal(run.stdout, '', JSON.stringify(args));
    assert.equal(run.stderr, `nexus: error: ${sentence}\n`, JSON.stringify(args));
  }
  assert.equal(agentTrees(home), before);
});

test('new refuses the name of an Installed Skill', () => {
  const home = newSkillHome('new-installed');
  const run = runNexus(home, ['new', 'installed']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    'nexus: error: name collides with an installed skill: installed ' +
      `(${join(home, '.agents', 'skills', 'installed')})\n`,
  );
  assert.ok(isAbsent(join(home, '.custom-skills', 'installed')));
});

test('new makes one empty directory, names its workspace, and links nothing', () => {
  const home = newSkillHome('new-created');
  const custom = join(home, '.custom-skills');
  const run = runNexus(home, ['new', 'mine']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(
    run.stdout,
    `nexus: created mine: ${join(custom, 'mine')}\n` +
      `nexus: workspace mine: ${join(custom, '.workspaces', 'mine')}\n`,
  );
  assert.deepEqual(readdirSync(join(custom, 'mine')), []);
  assert.ok(isAbsent(join(custom, '.workspaces')));
  assert.deepEqual(readdirSync(join(home, '.claude', 'skills')), []);
  assert.deepEqual(readdirSync(join(home, '.codex', 'skills')), []);

  const again = runNexus(home, ['new', 'mine']);
  assert.equal(again.status, 1);
  assert.equal(
    again.stderr,
    `nexus: error: custom skill already exists: ${join(custom, 'mine')}\n`,
  );
});

test('new works with no Nexus Lock, and refuses one that is invalid', () => {
  const home = newSkillHome('new-lock');
  rmSync(join(home, '.nexus', 'skill-lock.json'));
  const run = runNexus(home, ['new', 'installed']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^nexus: created installed: /);

  writeFileSync(join(home, '.nexus', 'skill-lock.json'), '{bad');
  const refused = runNexus(home, ['new', 'other']);
  assert.equal(refused.status, 1);
  assert.equal(
    refused.stderr,
    `nexus: error: invalid version-3 lock: ${join(home, '.nexus', 'skill-lock.json')} must be ` +
      'one JSON object with numeric version 3, object skills, and safe skill names\n',
  );
  assert.ok(isAbsent(join(home, '.custom-skills', 'other')));
});

test('without a Custom Root, new refuses instead of creating one', () => {
  const home = newSkillHome('new-no-root');
  rmSync(join(home, '.custom-skills'), { recursive: true });
  const run = runNexus(home, ['new', 'mine']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    `nexus: error: custom skill root does not exist: ${join(home, '.custom-skills')} ` +
      '(create it and run git init before adding custom skills)\n',
  );
  assert.ok(isAbsent(join(home, '.custom-skills')));

  writeFileSync(join(home, '.custom-skills'), 'not a directory');
  const file = runNexus(home, ['new', 'mine']);
  assert.equal(file.status, 1);
  assert.equal(
    file.stderr,
    'nexus: error: custom skill root must be a physical directory: ' +
      `${join(home, '.custom-skills')}\n`,
  );
  assert.equal(readFileSync(join(home, '.custom-skills'), 'utf8'), 'not a directory');
});
