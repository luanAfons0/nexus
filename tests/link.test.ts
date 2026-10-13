/**
 * `nexus link`: the one reconcile of both Native Skill Roots and both
 * Instruction Paths, with Managed Links as relative symlinks.
 *
 * These are the link cases of `tests/run.sh` and of
 * `tests/cases/global-instructions.sh`, carried over. The cases that need a
 * fault point (`link_snapshot_safety`) wait for #82, and the one that runs
 * Setup (`global_setup_ends_with_links`) waits for #81. On Linux the same
 * homes also run through the Bash CLI, and the bytes and the trees are
 * compared, because the Bash CLI is the specification.
 *
 * On Windows Link needs junctions and Managed Copies (#76); until then it
 * refuses with one sentence, and these cases skip.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
const ON_WINDOWS = WINDOWS && 'Link on Windows makes junctions and Managed Copies, which is #76';

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

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The names in `dir` that a staged link or a recovery container left. */
function residue(dir: string): readonly string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.nexus-'));
}

/**
 * A home with a Custom Root, both Agent Homes, one Installed and one Custom
 * Skill, and a lock, as `global_home` makes it.
 */
function globalHome(name: string): string {
  const home = customHome(name);
  writeSkill(join(home, '.agents', 'skills'), 'installed');
  writeSkill(join(home, '.custom-skills'), 'mine');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['installed']);
  return home;
}

/** Assert an Instruction Path is the relative Managed Link `../.custom-skills/GLOBAL.md`. */
function assertInstructionLink(home: string, path: string): void {
  assertLinkTo(path, join(home, '.custom-skills', 'GLOBAL.md'));
  assert.equal(linkText(path), '../.custom-skills/GLOBAL.md');
}

/** Assert the output names no Instruction Path and no Owner. */
function assertNoInstructionOutput(output: string): void {
  for (const word of ['CLAUDE.md', 'AGENTS.md', 'GLOBAL.md']) {
    assert.ok(!output.includes(word), `unexpected instruction output:\n${output}`);
  }
}

test('link with no lock refuses with the lock sentence and exits 1', { skip: ON_WINDOWS }, () => {
  const home = newHome('link_no_lock');
  const run = runNexus(home, ['link']);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(
    run.stderr,
    `nexus: error: invalid version-3 lock: expected regular file at ${join(home, '.nexus', 'skill-lock.json')}\n`,
  );
});

test('an invalid lock of any kind is refused and no Agent Home changes', { skip: ON_WINDOWS }, () => {
  const home = newHome('link_invalid_locks');
  const lock = join(home, '.nexus', 'skill-lock.json');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
  symlinkSync('../../.nexus/skills/nexus-setup', join(home, '.claude', 'skills', 'existing'));
  symlinkSync('../../.nexus/skills/nexus-link', join(home, '.codex', 'skills', 'existing'));
  const withName = (name: string) => JSON.stringify({ version: 3, skills: { [name]: {} } });
  const cases: readonly (string | undefined)[] = [
    undefined,
    '{not json\n',
    JSON.stringify({ version: 2, skills: { alpha: {} } }),
    JSON.stringify({ version: 3, skills: [] }),
    '{"version": 2, "skills": {}}\n{"version": 3, "skills": {}}\n',
    '{"version": 3, "skills": {}}\n{"version": 3, "skills": {"alpha": {}}}\n',
    ...['nexus-setup', '', '.', '..', 'bad/name', '../escape', '-bad', '_bad'].map(withName),
    ...['line\nbreak', 'tab\tkey', 'trailing\n'].map(withName),
  ];
  for (const content of cases) {
    rmSync(lock, { force: true });
    if (content !== undefined) writeFileSync(lock, content);
    const before = agentTrees(home);
    const run = runNexus(home, ['link']);
    assert.equal(run.status, 1, String(content));
    assert.ok(run.stderr.includes('invalid version-3 lock'), run.stderr);
    assert.equal(agentTrees(home), before, String(content));
  }
});

test(
  'link reconciles every desired skill, removes Stale Links, and keeps every Foreign Entry',
  { skip: ON_WINDOWS },
  () => {
    const home = newHome('link_reconciliation');
    const canonical = join(home, '.agents', 'skills');
    const claude = join(home, '.claude', 'skills');
    const codex = join(home, '.codex', 'skills');
    writeSkill(canonical, 'alpha');
    writeSkill(canonical, 'beta');
    writeSkill(canonical, 'stale');
    writeFileSync(join(canonical, 'stale', 'marker'), 'stale-marker\n');
    const staleBefore = sha256(join(canonical, 'stale', 'marker'));
    writeLock(join(home, '.nexus', 'skill-lock.json'), ['alpha', 'beta', 'missing']);
    mkdirSync(claude, { recursive: true });
    mkdirSync(join(codex, '.system'), { recursive: true });
    writeFileSync(join(codex, '.system', 'marker'), 'keep\n');
    symlinkSync('../../.agents/skills/beta', join(claude, 'alpha'));
    symlinkSync('../../.agents/skills/stale', join(claude, 'stale'));
    symlinkSync('../../.agents/skills/stale', join(codex, 'stale'));
    symlinkSync('../../.agents/skills/missing', join(claude, 'missing'));
    symlinkSync('../../.agents/skills/missing', join(codex, 'missing'));
    mkdirSync(join(home, '.agents', 'skills-elsewhere'));
    symlinkSync('../../.agents/skills-elsewhere/keep', join(claude, 'prefix-lookalike'));
    symlinkSync('/external/keep', join(codex, 'external-link'));
    writeFileSync(join(claude, 'unrelated-file'), 'physical\n');
    mkdirSync(join(codex, 'unrelated-dir'));

    const run = runNexus(home, ['link']);
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1);
    assert.ok(
      run.stderr.includes(
        `nexus: error: missing skill: missing (expected ${join(canonical, 'missing')}/SKILL.md)\n`,
      ),
      output,
    );
    assert.ok(run.stderr.endsWith('nexus: error: link failed with 1 error(s)\n'), output);
    for (const word of ['prefix-lookalike', 'external-link', 'unrelated-file', 'unrelated-dir']) {
      assert.ok(!output.includes(word), output);
    }
    for (const name of ['alpha', 'beta', ...CONTROL_SKILLS]) {
      const owner = CONTROL_SKILLS.includes(name) ? join(home, '.nexus', 'skills') : canonical;
      assertLinkTo(join(claude, name), join(owner, name));
      assertLinkTo(join(codex, name), join(owner, name));
    }
    for (const path of [join(claude, 'stale'), join(codex, 'stale')]) assert.ok(isAbsent(path));
    for (const path of [join(claude, 'missing'), join(codex, 'missing')]) assert.ok(isAbsent(path));
    assert.ok(run.stdout.includes(`nexus: removed stale managed link: ${join(claude, 'stale')}\n`));
    assert.ok(run.stdout.includes(`nexus: removed missing managed link: ${join(codex, 'missing')}\n`));
    assert.equal(sha256(join(canonical, 'stale', 'marker')), staleBefore);
    assert.equal(readFileSync(join(claude, 'unrelated-file'), 'utf8'), 'physical\n');
    assert.equal(readFileSync(join(codex, '.system', 'marker'), 'utf8'), 'keep\n');
    assert.ok(readdirSync(join(codex, 'unrelated-dir')).length === 0);
    assert.equal(linkText(join(claude, 'prefix-lookalike')), '../../.agents/skills-elsewhere/keep');
    assert.equal(linkText(join(codex, 'external-link')), '/external/keep');
    assert.deepEqual([...residue(claude), ...residue(codex)], []);

    const before = agentTrees(home);
    const again = runNexus(home, ['link']);
    assert.equal(again.status, 1);
    assert.ok(again.stderr.includes('missing skill: missing'));
    assert.equal(agentTrees(home), before);
  },
);

test(
  'a Stale Link is removed whether it reaches its Owner lexically or resolved, with an empty lock',
  { skip: ON_WINDOWS },
  () => {
    const home = newHome('link_stale_ownership');
    const canonical = join(home, '.agents', 'skills');
    mkdirSync(join(home, '.agents', 'skills-real'), { recursive: true });
    symlinkSync('skills-real', canonical);
    writeSkill(canonical, 'stale');
    writeFileSync(join(canonical, 'stale', 'marker'), 'stale-marker\n');
    const staleBefore = sha256(join(canonical, 'stale', 'marker'));
    symlinkSync('/external/target', join(canonical, 'alias'));
    writeLock(join(home, '.nexus', 'skill-lock.json'), []);
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
    const lexical = join(home, '.claude', 'skills', 'lexical-stale');
    const resolved = join(home, '.codex', 'skills', 'resolved-stale');
    symlinkSync('../../.agents/skills/alias/stale', lexical);
    symlinkSync(join(home, '.agents', 'skills-real', 'stale'), resolved);

    const run = runNexus(home, ['link']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(isAbsent(lexical) && isAbsent(resolved));
    assert.equal(sha256(join(canonical, 'stale', 'marker')), staleBefore);
    for (const name of ['nexus-setup', 'nexus-link', 'nexus-install']) {
      assertLinkTo(join(home, '.claude', 'skills', name), join(home, '.nexus', 'skills', name));
      assertLinkTo(join(home, '.codex', 'skills', name), join(home, '.nexus', 'skills', name));
    }
  },
);

test('a Foreign Entry at a desired link path is a Collision and is kept', { skip: ON_WINDOWS }, () => {
  const home = newHome('link_desired_collisions');
  writeSkill(join(home, '.agents', 'skills'), 'alpha');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['alpha']);
  mkdirSync(join(home, '.claude', 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'alpha', 'marker'), 'keep\n');
  symlinkSync('/external/alpha', join(home, '.codex', 'skills', 'alpha'));

  const run = runNexus(home, ['link']);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes(`nexus: error: collision at ${join(home, '.claude', 'skills', 'alpha')}\n`));
  assert.ok(
    run.stderr.includes(
      `nexus: error: collision at ${join(home, '.codex', 'skills', 'alpha')} (external symlink)\n`,
    ),
  );
  assert.ok(run.stderr.endsWith('nexus: error: link failed with 2 error(s)\n'));
  assert.equal(readFileSync(join(home, '.claude', 'skills', 'alpha', 'marker'), 'utf8'), 'keep\n');
  assert.equal(linkText(join(home, '.codex', 'skills', 'alpha')), '/external/alpha');
});

test(
  'Custom Skills are linked, lose their links when they leave the Custom Root, and an absent root is no error',
  { skip: ON_WINDOWS },
  () => {
    const home = customHome('custom_link');
    const custom = join(home, '.custom-skills');
    const canonical = join(home, '.agents', 'skills');
    writeSkill(canonical, 'installed');
    writeSkill(custom, 'mine');
    writeSkill(custom, 'other');
    writeLock(join(home, '.nexus', 'skill-lock.json'), ['installed']);

    let run = runNexus(home, ['link']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.endsWith('nexus: link complete: skills reconciled\n'), true);
    for (const name of ['mine', 'other']) {
      assertLinkTo(join(home, '.claude', 'skills', name), join(custom, name));
      assertLinkTo(join(home, '.codex', 'skills', name), join(custom, name));
    }
    assertLinkTo(join(home, '.claude', 'skills', 'installed'), join(canonical, 'installed'));
    assertLinkTo(join(home, '.codex', 'skills', 'nexus-new'), join(home, '.nexus', 'skills', 'nexus-new'));

    rmSync(join(custom, 'other'), { recursive: true });
    run = runNexus(home, ['link']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(isAbsent(join(home, '.claude', 'skills', 'other')));
    assert.ok(isAbsent(join(home, '.codex', 'skills', 'other')));
    assertLinkTo(join(home, '.claude', 'skills', 'mine'), join(custom, 'mine'));

    rmSync(custom, { recursive: true });
    run = runNexus(home, ['link']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!(run.stdout + run.stderr).includes('error'));
    assert.ok(isAbsent(join(home, '.claude', 'skills', 'mine')));
  },
);

test(
  'a Custom Root fault is a Preflight failure that names it and changes nothing',
  { skip: ON_WINDOWS },
  () => {
    const home = customHome('custom_validation');
    const custom = join(home, '.custom-skills');
    writeSkill(join(home, '.agents', 'skills'), 'installed');
    writeLock(join(home, '.nexus', 'skill-lock.json'), ['installed']);
    writeSkill(custom, 'mine');
    mkdirSync(join(custom, '.git'));
    mkdirSync(join(custom, '.workspaces', 'mine'), { recursive: true });
    writeFileSync(join(custom, 'README.md'), 'notes\n');

    let run = runNexus(home, ['link']);
    assert.equal(run.status, 0, run.stderr);
    for (const name of ['.git', '.workspaces', 'README.md']) {
      assert.ok(isAbsent(join(home, '.claude', 'skills', name)));
    }
    const trees = ['.claude', '.codex', '.agents'];
    const before = agentTrees(home, trees);
    const refused = (sentence: string) => {
      run = runNexus(home, ['link']);
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '');
      assert.equal(
        run.stderr,
        `nexus: error: ${sentence}\nnexus: error: link failed with 1 error(s); no changes were made\n`,
      );
      assert.equal(agentTrees(home, trees), before);
    };

    mkdirSync(join(custom, 'mine-workspace'));
    refused(`custom skill is missing SKILL.md: ${join(custom, 'mine-workspace', 'SKILL.md')}`);
    rmSync(join(custom, 'mine-workspace'), { recursive: true });

    symlinkSync(join(home, '.agents', 'skills', 'installed'), join(custom, 'aliased'));
    refused(`custom skill entry must not be a symlink: ${join(custom, 'aliased')}`);
    unlinkSync(join(custom, 'aliased'));

    renameSync(custom, join(home, '.custom-real'));
    symlinkSync(join(home, '.custom-real'), custom);
    refused(`custom skill root must be a physical directory: ${custom}`);
    unlinkSync(custom);
    renameSync(join(home, '.custom-real'), custom);

    writeSkill(custom, 'nexus-link');
    refused(`reserved control skill name in custom skill root: ${join(custom, 'nexus-link')}`);
  },
);

test(
  'a Custom Skill that shadows an Installed Skill, or is reached through the Canonical Root, changes nothing',
  { skip: ON_WINDOWS },
  () => {
    const home = customHome('custom_collision');
    const custom = join(home, '.custom-skills');
    const canonical = join(home, '.agents', 'skills');
    writeSkill(canonical, 'installed');
    writeLock(join(home, '.nexus', 'skill-lock.json'), ['installed']);
    writeSkill(custom, 'mine');
    assert.equal(runNexus(home, ['link']).status, 0);

    writeSkill(custom, 'installed');
    const before = agentTrees(home);
    let run = runNexus(home, ['link']);
    assert.equal(run.status, 1);
    assert.equal(
      run.stderr,
      `nexus: error: custom skill collides with an installed skill: installed ` +
        `(${join(custom, 'installed')} and ${join(canonical, 'installed')})\n` +
        'nexus: error: link failed with 1 error(s); no changes were made\n',
    );
    assert.equal(agentTrees(home), before);
    rmSync(join(custom, 'installed'), { recursive: true });

    symlinkSync(join(custom, 'mine'), join(canonical, 'mine'));
    run = runNexus(home, ['link']);
    assert.equal(run.status, 1);
    assert.equal(
      run.stderr,
      `nexus: error: custom skill link in canonical root: ${join(canonical, 'mine')} -> ` +
        `${join(custom, 'mine')} (remove it; custom skills are owned by ${custom})\n` +
        'nexus: error: link failed with 1 error(s); no changes were made\n',
    );
    unlinkSync(join(canonical, 'mine'));
    assert.equal(runNexus(home, ['link']).status, 0);
  },
);

test('link makes both Instruction Paths relative Managed Links to GLOBAL.md', { skip: ON_WINDOWS }, () => {
  const home = globalHome('global_create');
  writeFileSync(join(home, '.custom-skills', 'GLOBAL.md'), 'rule one\n');

  const run = runNexus(home, ['link']);
  assert.equal(run.status, 0, run.stderr);
  assertInstructionLink(home, join(home, '.claude', 'CLAUDE.md'));
  assertInstructionLink(home, join(home, '.codex', 'AGENTS.md'));
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'rule one\n');
  assert.equal(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), 'rule one\n');
  assertLinkTo(join(home, '.claude', 'skills', 'mine'), join(home, '.custom-skills', 'mine'));
  assert.equal(linkText(join(home, '.custom-skills', 'GLOBAL.md')), undefined);
});

test('a second link changes nothing and says nothing about the Instruction Paths', { skip: ON_WINDOWS }, () => {
  const home = globalHome('global_idempotent');
  writeFileSync(join(home, '.custom-skills', 'GLOBAL.md'), 'rule one\n');
  assert.equal(runNexus(home, ['link']).status, 0);
  const before = agentTrees(home);

  const run = runNexus(home, ['link']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'nexus: link complete: skills reconciled\n');
  assert.equal(run.stderr, '');
  assert.equal(agentTrees(home), before);
});

test('link repoints a Managed Link at an Instruction Path that reaches the wrong Owner', { skip: ON_WINDOWS }, () => {
  const home = globalHome('global_repair');
  writeFileSync(join(home, '.custom-skills', 'GLOBAL.md'), 'rule one\n');
  symlinkSync('../.custom-skills/mine/SKILL.md', join(home, '.claude', 'CLAUDE.md'));
  symlinkSync('../.agents/skills/installed/SKILL.md', join(home, '.codex', 'AGENTS.md'));

  const run = runNexus(home, ['link']);
  assert.equal(run.status, 0, run.stderr);
  assertInstructionLink(home, join(home, '.claude', 'CLAUDE.md'));
  assertInstructionLink(home, join(home, '.codex', 'AGENTS.md'));
  assert.ok(!isAbsent(join(home, '.custom-skills', 'mine', 'SKILL.md')));
  assert.ok(!isAbsent(join(home, '.agents', 'skills', 'installed', 'SKILL.md')));
});

test('an empty GLOBAL.md is linked and says nothing', { skip: ON_WINDOWS }, () => {
  const home = globalHome('global_empty');
  writeFileSync(join(home, '.custom-skills', 'GLOBAL.md'), '');

  const run = runNexus(home, ['link']);
  assert.equal(run.status, 0, run.stderr);
  assertInstructionLink(home, join(home, '.claude', 'CLAUDE.md'));
  assertInstructionLink(home, join(home, '.codex', 'AGENTS.md'));
  assertNoInstructionOutput(run.stdout + run.stderr);
  assert.equal(readFileSync(join(home, '.custom-skills', 'GLOBAL.md'), 'utf8'), '');
});

test('an absent GLOBAL.md is one notice, and a file at an Instruction Path is kept', { skip: ON_WINDOWS }, () => {
  const home = globalHome('global_absent_owner');
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'hand written\n');

  const run = runNexus(home, ['link']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(
    run.stdout,
    `nexus: global instructions are absent: ${join(home, '.custom-skills', 'GLOBAL.md')} ` +
      '(create it and rerun link to link the Instruction Paths)\n' +
      'nexus: link complete: skills reconciled\n',
  );
  assert.equal(linkText(join(home, '.claude', 'CLAUDE.md')), undefined);
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'hand written\n');
  assert.ok(isAbsent(join(home, '.codex', 'AGENTS.md')));
  assertLinkTo(join(home, '.claude', 'skills', 'mine'), join(home, '.custom-skills', 'mine'));
  assertLinkTo(join(home, '.codex', 'skills', 'installed'), join(home, '.agents', 'skills', 'installed'));
});

test(
  'when GLOBAL.md goes, link removes its Managed Link and keeps an unrelated symlink',
  { skip: ON_WINDOWS },
  () => {
    const home = globalHome('global_absent_stale');
    writeFileSync(join(home, '.custom-skills', 'GLOBAL.md'), 'rule one\n');
    assert.equal(runNexus(home, ['link']).status, 0);
    assertInstructionLink(home, join(home, '.claude', 'CLAUDE.md'));
    unlinkSync(join(home, '.custom-skills', 'GLOBAL.md'));
    unlinkSync(join(home, '.codex', 'AGENTS.md'));
    symlinkSync('/unrelated/AGENTS.md', join(home, '.codex', 'AGENTS.md'));

    const run = runNexus(home, ['link']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(isAbsent(join(home, '.claude', 'CLAUDE.md')));
    assert.ok(
      run.stdout.includes(`nexus: removed stale managed link: ${join(home, '.claude', 'CLAUDE.md')}\n`),
    );
    assert.equal(linkText(join(home, '.codex', 'AGENTS.md')), '/unrelated/AGENTS.md');
    assert.ok(!run.stdout.includes(join(home, '.codex', 'AGENTS.md')));
  },
);

test('a file at an Instruction Path is a Foreign Entry: kept, with a hint, and no error', { skip: ON_WINDOWS }, () => {
  const home = globalHome('global_foreign_file');
  const global = join(home, '.custom-skills', 'GLOBAL.md');
  const claude = join(home, '.claude', 'CLAUDE.md');
  writeFileSync(global, 'rule one\n');
  writeFileSync(claude, 'hand written\n');

  const run = runNexus(home, ['link']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.ok(
    run.stdout.includes(
      `nexus: foreign entry at ${claude}: preserved; to manage it, run: mv ${claude} ${global}, then rerun link\n`,
    ),
  );
  assert.equal(linkText(claude), undefined);
  assert.equal(readFileSync(claude, 'utf8'), 'hand written\n');
  assertInstructionLink(home, join(home, '.codex', 'AGENTS.md'));
  assert.deepEqual(residue(join(home, '.claude')), []);
});

test('an unrelated symlink at an Instruction Path is a Foreign Entry and is kept', { skip: ON_WINDOWS }, () => {
  const home = globalHome('global_foreign_symlink');
  const global = join(home, '.custom-skills', 'GLOBAL.md');
  const codex = join(home, '.codex', 'AGENTS.md');
  writeFileSync(global, 'rule one\n');
  symlinkSync('/unrelated/AGENTS.md', codex);

  const run = runNexus(home, ['link']);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(
    run.stdout.includes(
      `nexus: foreign entry at ${codex}: preserved; to manage it, run: mv ${codex} ${global}, then rerun link\n`,
    ),
  );
  assert.equal(linkText(codex), '/unrelated/AGENTS.md');
  assertInstructionLink(home, join(home, '.claude', 'CLAUDE.md'));
});

test('an absent Agent Home is no error, and no file appears at its Instruction Path', { skip: ON_WINDOWS }, () => {
  const home = globalHome('global_no_codex');
  writeFileSync(join(home, '.custom-skills', 'GLOBAL.md'), 'rule one\n');
  rmSync(join(home, '.codex'), { recursive: true });

  const run = runNexus(home, ['link']);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!(run.stdout + run.stderr).includes('error'));
  assertInstructionLink(home, join(home, '.claude', 'CLAUDE.md'));
  // The skill links make the Codex home first, so its Instruction Path is linked too.
  assertInstructionLink(home, join(home, '.codex', 'AGENTS.md'));
});

// GLOBAL.md sits at the top of the Custom Root, so the Custom Skill scan
// names it too: as a symlink entry, or as a directory with no SKILL.md.
for (const [kind, make, scan] of [
  [
    'symlink',
    (global: string) => symlinkSync('mine/SKILL.md', global),
    (global: string) => `custom skill entry must not be a symlink: ${global}`,
  ],
  [
    'directory',
    (global: string) => mkdirSync(global),
    (global: string) => `custom skill is missing SKILL.md: ${join(global, 'SKILL.md')}`,
  ],
] as const) {
  test(`a GLOBAL.md that is a ${kind} is a Preflight fault that changes nothing`, { skip: ON_WINDOWS }, () => {
    const home = globalHome(`global_invalid_${kind}`);
    const global = join(home, '.custom-skills', 'GLOBAL.md');
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'hand written\n');
    symlinkSync('../.custom-skills/mine/SKILL.md', join(home, '.codex', 'AGENTS.md'));
    make(global);
    const before = agentTrees(home);

    const run = runNexus(home, ['link']);
    assert.equal(run.status, 1);
    assert.equal(
      run.stderr,
      `nexus: error: global instructions must be a regular file, not a ${kind}: ${global}\n` +
        `nexus: error: ${scan(global)}\n` +
        'nexus: error: link failed with 2 error(s); no changes were made\n',
    );
    assert.equal(agentTrees(home), before);
    assert.ok(isAbsent(join(home, '.claude', 'skills', 'mine')));
    assert.ok(isAbsent(join(home, '.claude', 'skills', 'nexus-link')));
  });
}

test('every Preflight fault is named before the count, and nothing changes', { skip: ON_WINDOWS }, () => {
  const home = customHome('link_preflight_all');
  const custom = join(home, '.custom-skills');
  const canonical = join(home, '.agents', 'skills');
  writeSkill(canonical, 'installed');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['installed']);
  writeSkill(custom, 'installed');
  writeSkill(custom, 'mine');
  mkdirSync(join(custom, 'no-skill'));
  symlinkSync(join(custom, 'mine'), join(canonical, 'mine'));
  symlinkSync('mine/SKILL.md', join(custom, 'GLOBAL.md'));
  const before = agentTrees(home);

  const run = runNexus(home, ['link']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    [
      `global instructions must be a regular file, not a symlink: ${join(custom, 'GLOBAL.md')}`,
      `custom skill entry must not be a symlink: ${join(custom, 'GLOBAL.md')}`,
      `custom skill is missing SKILL.md: ${join(custom, 'no-skill', 'SKILL.md')}`,
      `custom skill link in canonical root: ${join(canonical, 'mine')} -> ${join(custom, 'mine')} ` +
        `(remove it; custom skills are owned by ${custom})`,
      `custom skill collides with an installed skill: installed ` +
        `(${join(custom, 'installed')} and ${join(canonical, 'installed')})`,
      'link failed with 5 error(s); no changes were made',
    ]
      .map((line) => `nexus: error: ${line}\n`)
      .join(''),
  );
  assert.equal(agentTrees(home), before);
});

test(
  'link says the same bytes and leaves the same trees as the Bash CLI',
  { skip: WINDOWS && 'the Bash CLI runs on Linux alone' },
  () => {
    const scenes: Record<string, (home: string) => void> = {
      reconcile: (home) => {
        const canonical = join(home, '.agents', 'skills');
        writeSkill(canonical, 'alpha');
        writeSkill(canonical, 'stale');
        writeSkill(join(home, '.custom-skills'), 'mine');
        writeLock(join(home, '.nexus', 'skill-lock.json'), ['alpha', 'missing']);
        mkdirSync(join(home, '.codex', 'skills', '.system'), { recursive: true });
        symlinkSync('../../.agents/skills/stale', join(home, '.claude', 'skills', 'stale'));
        symlinkSync('../../.agents/skills/missing', join(home, '.codex', 'skills', 'missing'));
        symlinkSync('../../.agents/skills/stale', join(home, '.codex', 'skills', 'alpha'));
        symlinkSync('/external/keep', join(home, '.codex', 'skills', 'external'));
        mkdirSync(join(home, '.claude', 'skills', 'nexus-new'));
        symlinkSync('/external/link', join(home, '.codex', 'skills', 'nexus-help'));
        writeFileSync(join(home, '.custom-skills', 'GLOBAL.md'), 'rule one\n');
        writeFileSync(join(home, '.codex', 'AGENTS.md'), 'mine\n');
      },
      'no-owner': (home) => {
        writeLock(join(home, '.nexus', 'skill-lock.json'), []);
        symlinkSync('../.custom-skills/GLOBAL.md', join(home, '.claude', 'CLAUDE.md'));
        symlinkSync('/unrelated/AGENTS.md', join(home, '.codex', 'AGENTS.md'));
      },
      'no-homes': (home) => {
        writeLock(join(home, '.nexus', 'skill-lock.json'), []);
        writeFileSync(join(home, '.custom-skills', 'GLOBAL.md'), 'rule one\n');
        rmSync(join(home, '.claude'), { recursive: true });
      },
      preflight: (home) => {
        const custom = join(home, '.custom-skills');
        writeSkill(join(home, '.agents', 'skills'), 'installed');
        writeLock(join(home, '.nexus', 'skill-lock.json'), ['installed']);
        writeSkill(custom, 'installed');
        mkdirSync(join(custom, 'bad name'));
        symlinkSync(join(home, '.agents'), join(custom, 'aliased'));
        symlinkSync(join(custom, 'installed'), join(home, '.agents', 'skills', '.hidden'));
        mkdirSync(join(custom, 'GLOBAL.md'));
      },
      'custom-root-file': (home) => {
        rmSync(join(home, '.custom-skills'), { recursive: true });
        writeFileSync(join(home, '.custom-skills'), '');
        writeLock(join(home, '.nexus', 'skill-lock.json'), []);
      },
      'stale-ownership': (home) => {
        const canonical = join(home, '.agents', 'skills');
        renameSync(canonical, join(home, '.agents', 'skills-real'));
        symlinkSync('skills-real', canonical);
        writeSkill(canonical, 'stale');
        symlinkSync('/external/target', join(canonical, 'alias'));
        writeLock(join(home, '.nexus', 'skill-lock.json'), []);
        symlinkSync('../../.agents/skills/alias/stale', join(home, '.claude', 'skills', 'lexical'));
        symlinkSync(join(home, '.agents', 'skills-real', 'stale'), join(home, '.codex', 'skills', 'resolved'));
        symlinkSync('../../.nexus/skills/alias/nexus-setup', join(home, '.claude', 'skills', 'nexus-setup'));
        symlinkSync('../../.agents/skills-elsewhere/x', join(home, '.claude', 'skills', 'lookalike'));
      },
      'no-lock': () => undefined,
      'bad-lock': (home) => writeFileSync(join(home, '.nexus', 'skill-lock.json'), '{"version":3,"skills":{"../x":{}}}'),
    };
    for (const [name, fill] of Object.entries(scenes)) {
      const bash = customHome(`link-bash-${name}`);
      const node = customHome(`link-node-${name}`);
      fill(bash);
      fill(node);
      for (const round of [1, 2]) {
        const expected = runBash(bash, ['link']);
        const actual = runNexus(node, ['link']);
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
  'on Windows link refuses with one sentence until it has junctions and Managed Copies',
  { skip: !WINDOWS && 'the refusal is for Windows alone' },
  () => {
    const home = customHome('link_windows');
    const before = agentTrees(home);
    const run = runNexus(home, ['link']);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(
      run.stderr,
      'nexus: error: link does not run on Windows yet; run Nexus inside WSL for now\n',
    );
    assert.equal(agentTrees(home), before);
  },
);
