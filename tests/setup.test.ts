/**
 * `nexus setup`: discover the Upstream Lock, take the Backup, Publish the
 * first Nexus Lock, make the Canonical Root own its skills, and link.
 *
 * These are the setup cases of `tests/run.sh` and
 * `tests/cases/global-instructions.sh` that need no fault point, carried
 * over. The cases that need one (a failed or corrupt copy, a failed
 * promotion, a late collision, a signal in a held window) wait for #82; the
 * Backup's own cases are in `backup.test.ts`. On Linux the same homes also
 * run through the Bash CLI, and the bytes and the trees are compared,
 * because the Bash CLI is the specification.
 *
 * On Windows a home's links are junctions, as `makeLink` makes them, a
 * Managed Link is a junction, and an Instruction Path a Managed Copy (ADR
 * 0010). A symlink inside a skill needs a privilege there, so the nested
 * symlink cases run on Linux and macOS alone.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { snapshotTree, writeLock, writeSkill } from './helpers/homes.ts';
import {
  assertLinkText,
  assertLinkTo,
  assertManagedCopy,
  isAbsent,
  linkText,
  makeLink,
  WINDOWS,
} from './helpers/links.ts';
import { newHome, runNexus, testRoot } from './helpers/nexus.ts';
import { assertSetupSameAsBash, runSetup, setupResidue } from './helpers/setup.ts';

const BASH_PARITY = WINDOWS && 'the Bash CLI runs on Linux alone';
const NESTED = WINDOWS && 'a symlink inside a skill needs a privilege on Windows';

/** Every tree of a home Setup may touch, as one snapshot. */
function homeTrees(home: string): string {
  return ['.nexus', '.agents', '.claude', '.codex', '.claude-backup', '.codex-backup']
    .map((dir) => `${dir}:\n${snapshotTree(join(home, dir)).join('\n')}`)
    .join('\n');
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Write the lock at `from` again at `to`, every key sorted: the same lock, other bytes (`jq -S`). */
function writeSortedCopy(from: string, to: string): void {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value === null || typeof value !== 'object') return value;
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, each]) => [key, sort(each)]));
  };
  write(to, `${JSON.stringify(sort(JSON.parse(readFileSync(from, 'utf8'))), null, 2)}\n`);
}

/**
 * The home of `setup_happy_and_idempotent`: two Installed Skills, one a
 * symlink into Claude's skills; Foreign Entries at both agents' skill paths;
 * Codex's `.system`; an unmanaged Canonical Root link; and agent files of
 * every kind the Backup must keep.
 */
function happyHome(home: string): void {
  writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha', 'beta']);
  mkdirSync(join(home, '.claude', 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(home, '.codex', 'skills', '.system'), { recursive: true });
  write(join(home, '.claude', '.hidden'), 'hidden\n');
  write(join(home, '.claude', 'run-me'), 'executable\n');
  makeLink('/ordinary/link', join(home, '.claude', 'ordinary-link'));
  write(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'alpha-content\n');
  write(join(home, '.claude', 'skills', 'beta'), 'replace-file\n');
  makeLink('/external/beta', join(home, '.codex', 'skills', 'beta'));
  write(join(home, '.codex', 'state'), 'state\n');
  write(join(home, '.codex', 'skills', '.system', 'marker'), 'system\n');
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
  makeLink('../../.claude/skills/alpha', join(home, '.agents', 'skills', 'alpha'));
  writeSkill(join(home, '.agents', 'skills'), 'beta');
  makeLink('/external/unmanaged', join(home, '.agents', 'skills', 'unmanaged'));
}

/** Existing Backups beside a broken lock: the Preflight refuses first. */
function existingBackupsHome(home: string): void {
  write(join(home, '.agents', '.skill-lock.json'), '{broken\n');
  write(join(home, '.claude-backup', 'marker'), 'keep\n');
  write(join(home, '.codex-backup', 'marker'), 'keep\n');
}

/** Three valid candidates that say three different things. */
function conflictingHome(home: string): void {
  writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
  writeLock(join(home, '.agents', 'skill-lock.json'), ['beta']);
  writeLock(join(home, '.skills', '.skill-lock.json'), ['gamma']);
}

/** Two invalid candidates before a valid one. */
function invalidCandidateHome(home: string): void {
  write(join(home, '.agents', '.skill-lock.json'), '{bad\n');
  write(join(home, '.agents', 'skill-lock.json'), '{also-bad\n');
  writeLock(join(home, '.skills', '.skill-lock.json'), ['alpha']);
}

/** A lock with no candidate anywhere. */
function noCandidateHome(home: string): void {
  mkdirSync(join(home, '.agents'), { recursive: true });
}

/** A Canonical Root entry that is a broken symlink. */
function brokenCanonicalHome(home: string): void {
  writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(home, '.codex', 'skills', 'alpha'), { recursive: true });
  makeLink('/missing/alpha', join(home, '.agents', 'skills', 'alpha'));
}

/** `~/.agents` is a symlink to Claude's home. */
function symlinkedAgentsHome(home: string): void {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(home, '.agents-real'), { recursive: true });
  makeLink('.claude', join(home, '.agents'));
  writeLock(join(home, '.claude', '.skill-lock.json'), ['alpha']);
}

/** A Canonical Root skill whose `SKILL.md` is a symlink. */
function symlinkedSkillFileHome(home: string): void {
  writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
  mkdirSync(join(home, '.agents', 'skills', 'alpha'), { recursive: true });
  write(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'live\n');
  makeLink(
    '../../../.claude/skills/alpha/SKILL.md',
    join(home, '.agents', 'skills', 'alpha', 'SKILL.md'),
  );
}

/** A Canonical Root symlink to a skill whose own links `addLinks` makes. */
function nestedHome(addLinks: (skill: string, home: string) => void): (home: string) => void {
  return (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
    const skill = join(home, '.claude', 'skills', 'alpha');
    write(join(skill, 'SKILL.md'), 'alpha\n');
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
    addLinks(skill, home);
    makeLink('../../.claude/skills/alpha', join(home, '.agents', 'skills', 'alpha'));
  };
}

const nestedEscape = nestedHome((skill) => {
  const outside = join(testRoot(), 'nested-secret');
  writeFileSync(outside, 'secret\n');
  symlinkSync(outside, join(skill, 'secret'));
});
const nestedBroken = nestedHome((skill) => symlinkSync('missing', join(skill, 'broken')));
const nestedCyclic = nestedHome((skill) => {
  symlinkSync('cycle-b', join(skill, 'cycle-a'));
  symlinkSync('cycle-a', join(skill, 'cycle-b'));
});
const nestedInternal = nestedHome((skill) => {
  writeFileSync(join(skill, 'target'), 'nested\n');
  symlinkSync('target', join(skill, 'nested'));
});

test('setup moves an Agent Context under Nexus and keeps every Foreign Entry', () => {
  const { home, run } = runSetup('setup_happy', happyHome);
  assert.equal(run.status, 0, run.stderr);
  const source = join(home, '.agents', '.skill-lock.json');
  const canonical = join(home, '.agents', 'skills');
  assert.ok(statSync(join(home, '.claude')).isDirectory());
  assert.ok(statSync(join(home, '.codex')).isDirectory());
  assert.equal(readFileSync(join(home, '.claude-backup', '.hidden'), 'utf8'), 'hidden\n');
  assertLinkText(join(home, '.claude-backup', 'ordinary-link'), '/ordinary/link');
  assert.ok(statSync(join(home, '.claude-backup', 'skills', 'alpha', 'SKILL.md')).isFile());
  assert.ok(statSync(join(home, '.codex-backup', 'skills', '.system', 'marker')).isFile());
  // The symlinked Installed Skill is now a physical copy in the Canonical Root.
  assert.ok(lstatSync(join(canonical, 'alpha')).isDirectory());
  assert.equal(readFileSync(join(canonical, 'alpha', 'SKILL.md'), 'utf8'), 'alpha-content\n');
  for (const agent of ['.claude', '.codex']) {
    assertLinkTo(join(home, agent, 'skills', 'alpha'), join(canonical, 'alpha'));
    assertLinkTo(join(home, agent, 'skills', 'beta'), join(canonical, 'beta'));
  }
  // The Foreign Entries Setup replaced are kept in the Backups.
  assert.ok(lstatSync(join(home, '.claude-backup', 'skills', 'beta')).isFile());
  assert.ok(lstatSync(join(home, '.codex-backup', 'skills', 'beta')).isSymbolicLink());
  assertLinkText(join(canonical, 'unmanaged'), '/external/unmanaged');
  assert.ok(statSync(join(home, '.codex', 'skills', '.system', 'marker')).isFile());
  assert.ok(readFileSync(source).equals(readFileSync(join(home, '.nexus', 'skill-lock.json'))));
  const output = run.stdout + run.stderr;
  assert.ok(output.includes(source));
  assert.ok(output.includes(join(home, '.claude-backup')));
  assert.ok(output.includes(join(home, '.codex-backup')));
  assert.match(run.stdout, /third-party skills: 2; linked agent skill entries: 20 /);
  assert.deepEqual(setupResidue(home), []);
  assert.ok(isAbsent(join(home, '.nexus', '.nexus-setup.lock')));
});

test('a second setup says it is already initialized and changes nothing', () => {
  const { home, run } = runSetup('setup_idempotent', happyHome);
  assert.equal(run.status, 0, run.stderr);
  const before = homeTrees(home);
  const again = runNexus(home, ['setup']);
  assert.equal(again.status, 0);
  assert.equal(
    again.stdout,
    'nexus: already initialized; run /nexus-link or $nexus-link to reconcile skills\n',
  );
  assert.equal(again.stderr, '');
  assert.equal(homeTrees(home), before);
});

test('an existing Backup refuses setup before anything changes, naming both', () => {
  const home = newHome('setup_preflight');
  existingBackupsHome(home);
  const before = snapshotTree(home);
  const run = runNexus(home, ['setup']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    `nexus: error: backup already exists: ${join(home, '.claude-backup')}\n` +
      `nexus: error: backup already exists: ${join(home, '.codex-backup')}\n`,
  );
  assert.deepEqual(snapshotTree(home), before);
  assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')));
  assert.deepEqual(setupResidue(home), []);
});

test('a setup mutex in the Nexus home refuses another setup and changes nothing', () => {
  const home = newHome('setup_mutex');
  writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
  mkdirSync(join(home, '.nexus', '.nexus-setup.lock'));
  const before = snapshotTree(home);
  const run = runNexus(home, ['setup']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    'nexus: error: another setup is already running or recovery is required: ' +
      `${join(home, '.nexus', '.nexus-setup.lock')}\n`,
  );
  assert.deepEqual(snapshotTree(home), before);
  assert.ok(isAbsent(join(home, '.claude-backup')));
  assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')));
});

test('lock candidates that say the same thing publish the first, byte for byte', () => {
  const { home, run } = runSetup('setup_candidates', (home) => {
    const one = join(home, '.agents', '.skill-lock.json');
    writeLock(one, ['alpha']);
    writeSortedCopy(one, join(home, '.skills', 'skill-lock.json'));
    writeSkill(join(home, '.agents', 'skills'), 'alpha');
  });
  assert.equal(run.status, 0, run.stderr);
  const one = readFileSync(join(home, '.agents', '.skill-lock.json'));
  const two = readFileSync(join(home, '.skills', 'skill-lock.json'));
  assert.ok(!one.equals(two));
  assert.ok(one.equals(readFileSync(join(home, '.nexus', 'skill-lock.json'))));
  assert.deepEqual(setupResidue(home, ['.nexus-lock-candidates.']), []);
});

test('conflicting lock candidates refuse setup, naming each, and change nothing', () => {
  const home = newHome('setup_conflicts');
  conflictingHome(home);
  const before = snapshotTree(home);
  const run = runNexus(home, ['setup']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    'nexus: error: conflicting setup lock candidates: ' +
      `${join(home, '.agents', '.skill-lock.json')} ${join(home, '.agents', 'skill-lock.json')} ` +
      `${join(home, '.skills', '.skill-lock.json')}\n`,
  );
  assert.deepEqual(snapshotTree(home), before);
  assert.deepEqual(setupResidue(home, ['.nexus-lock', '.nexus-setup']), []);
});

test('an invalid lock candidate refuses setup, naming every invalid one', () => {
  const home = newHome('setup_invalid_candidate');
  invalidCandidateHome(home);
  const before = snapshotTree(home);
  const run = runNexus(home, ['setup']);
  assert.equal(run.status, 1);
  const last = run.stderr.trimEnd().split('\n').at(-1);
  assert.equal(
    last,
    'nexus: error: invalid setup lock candidates: ' +
      `${join(home, '.agents', '.skill-lock.json')} ${join(home, '.agents', 'skill-lock.json')}`,
  );
  assert.deepEqual(snapshotTree(home), before);
  assert.ok(isAbsent(join(home, '.claude-backup')));
  assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')));
  assert.deepEqual(setupResidue(home, ['.nexus-lock', '.nexus-setup']), []);
});

test('no lock candidate anywhere refuses setup, naming every place it looked', () => {
  const home = newHome('setup_no_candidate');
  noCandidateHome(home);
  const run = runNexus(home, ['setup']);
  assert.equal(run.status, 1);
  const checked = [
    join(home, '.agents', '.skill-lock.json'),
    join(home, '.agents', 'skill-lock.json'),
    join(home, '.skills', '.skill-lock.json'),
    join(home, '.skills', 'skill-lock.json'),
  ].join(' ');
  assert.equal(run.stderr, `nexus: error: no version-3 skill lock found (checked: ${checked})\n`);
  assert.deepEqual(setupResidue(home, ['.nexus-lock', '.nexus-setup']), []);
});

test('a lock that names a Control Skill refuses setup and changes nothing', () => {
  for (const reserved of ['nexus-setup', 'nexus-help', 'nexus-update', 'nexus-remove', 'nexus']) {
    const home = newHome(`setup_reserved_control_${reserved}`);
    writeLock(join(home, '.agents', '.skill-lock.json'), [reserved]);
    const before = snapshotTree(home);
    const run = runNexus(home, ['setup']);
    assert.equal(run.status, 1, reserved);
    assert.match(run.stderr, /invalid setup lock candidates/, reserved);
    assert.deepEqual(snapshotTree(home), before, reserved);
    assert.ok(isAbsent(join(home, '.claude-backup')), reserved);
    assert.ok(isAbsent(join(home, '.codex-backup')), reserved);
    assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')), reserved);
    assert.deepEqual(setupResidue(home), [], reserved);
  }
});

test('a broken Canonical Root symlink fails after publication and keeps the lock and both Backups', () => {
  const { home, run } = runSetup('setup_broken_canonical', brokenCanonicalHome);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /broken symlink/);
  assert.match(run.stderr, /setup is now initialized\/disabled/);
  assert.ok(run.stderr.includes('/nexus-link') && run.stderr.includes('$nexus-link'));
  assert.ok(statSync(join(home, '.nexus', 'skill-lock.json')).isFile());
  assert.ok(statSync(join(home, '.claude-backup')).isDirectory());
  assert.ok(statSync(join(home, '.codex-backup')).isDirectory());
  assert.ok(statSync(join(home, '.claude', 'skills', 'alpha')).isDirectory());
  assert.ok(statSync(join(home, '.codex', 'skills', 'alpha')).isDirectory());
  assert.deepEqual(setupResidue(home), []);
});

test('a symlinked ~/.agents refuses setup before anything changes', () => {
  const home = newHome('setup_canonical_root_symlink');
  symlinkedAgentsHome(home);
  const before = snapshotTree(home);
  const run = runNexus(home, ['setup']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /canonical agent root must be a physical directory/);
  assert.deepEqual(snapshotTree(home), before);
  assert.ok(isAbsent(join(home, '.claude-backup')));
  assert.ok(isAbsent(join(home, '.nexus', 'skill-lock.json')));
});

test('a Canonical Root SKILL.md that is a symlink fails after publication and keeps the agents', () => {
  const { home, run } = runSetup('setup_skill_md_symlink', symlinkedSkillFileHome);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /physical SKILL\.md/);
  assert.ok(statSync(join(home, '.nexus', 'skill-lock.json')).isFile());
  assert.ok(statSync(join(home, '.claude-backup')).isDirectory());
  assert.ok(statSync(join(home, '.codex-backup')).isDirectory());
  assert.ok(lstatSync(join(home, '.claude', 'skills', 'alpha')).isDirectory());
});

test('a nested symlink that escapes, breaks or loops keeps the Canonical Root symlink', { skip: NESTED }, () => {
  const cases = [
    ['nested_escape', nestedEscape],
    ['nested_broken', nestedBroken],
    ['nested_cyclic', nestedCyclic],
  ] as const;
  for (const [name, build] of cases) {
    const { home, run } = runSetup(name, build);
    assert.equal(run.status, 1, name);
    assert.match(run.stderr, /nested source symlink/, name);
    assert.ok(run.stderr.includes('/nexus-link') && run.stderr.includes('$nexus-link'), name);
    assert.equal(linkText(join(home, '.agents', 'skills', 'alpha')), '../../.claude/skills/alpha');
    assert.ok(statSync(join(home, '.nexus', 'skill-lock.json')).isFile(), name);
    assert.ok(statSync(join(home, '.claude-backup')).isDirectory(), name);
    assert.ok(statSync(join(home, '.codex-backup')).isDirectory(), name);
  }
  assert.equal(readFileSync(join(testRoot(), 'nested-secret'), 'utf8'), 'secret\n');
});

test('a nested symlink inside the skill is copied as the file it reaches', { skip: NESTED }, () => {
  const { home, run } = runSetup('nested_internal', nestedInternal);
  assert.equal(run.status, 0, run.stderr);
  const canonical = join(home, '.agents', 'skills', 'alpha');
  assert.ok(lstatSync(canonical).isDirectory());
  assert.ok(lstatSync(join(canonical, 'nested')).isFile());
  assert.equal(readFileSync(join(canonical, 'nested'), 'utf8'), 'nested\n');
});

test('a TMPDIR with a trailing slash leaves no canonical scan behind', () => {
  const home = newHome('canonical_scan_trailing_tmpdir');
  mkdirSync(join(home, 'tmp'));
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.codex'));
  writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
  write(join(home, '.agents', 'skills', 'alpha', 'SKILL.md'), 'skill\n');
  const run = runNexus(home, ['setup'], { env: { TMPDIR: `${join(home, 'tmp')}/` } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readdirSync(join(home, 'tmp')), []);
});

test('setup ends with both Instruction Paths linked to GLOBAL.md', () => {
  const { home, run } = runSetup('global_setup', (home) => {
    for (const dir of ['.claude', '.codex', '.custom-skills', '.agents/skills']) {
      mkdirSync(join(home, dir), { recursive: true });
    }
    writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
    writeSkill(join(home, '.agents', 'skills'), 'alpha');
    writeFileSync(join(home, '.custom-skills', 'GLOBAL.md'), 'rule one\n');
  });
  assert.equal(run.status, 0, run.stderr);
  const owner = join(home, '.custom-skills', 'GLOBAL.md');
  for (const path of [join(home, '.claude', 'CLAUDE.md'), join(home, '.codex', 'AGENTS.md')]) {
    if (WINDOWS) {
      assertManagedCopy(home, path, owner);
    } else {
      assertLinkTo(path, owner);
      assert.equal(linkText(path), '../.custom-skills/GLOBAL.md');
    }
  }
  assertLinkTo(join(home, '.claude', 'skills', 'alpha'), join(home, '.agents', 'skills', 'alpha'));
});

test('setup replaces a Foreign Entry at a skill path and keeps an unrelated recovery container', () => {
  const { home, run } = runSetup('force_directory', (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), []);
    const parent = join(home, '.claude', 'skills');
    write(join(parent, 'nexus-setup', 'marker'), 'directory-marker\n');
    write(join(parent, '.nexus-backup.fixed', 'marker'), 'sibling-marker\n');
  });
  assert.equal(run.status, 0, run.stderr);
  const parent = join(home, '.claude', 'skills');
  assertLinkTo(join(parent, 'nexus-setup'), join(home, '.nexus', 'skills', 'nexus-setup'));
  assert.equal(readFileSync(join(parent, '.nexus-backup.fixed', 'marker'), 'utf8'), 'sibling-marker\n');
  const containers = readdirSync(parent).filter((name) => name.startsWith('.nexus-backup.'));
  assert.deepEqual(containers, ['.nexus-backup.fixed']);
  // The replaced directory is in the Backup.
  const kept = join(home, '.claude-backup', 'skills', 'nexus-setup', 'marker');
  assert.equal(readFileSync(kept, 'utf8'), 'directory-marker\n');

  const file = runSetup('force_file', (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), []);
    write(join(home, '.claude', 'skills', 'nexus-setup'), 'file-marker\n');
  });
  assert.equal(file.run.status, 0, file.run.stderr);
  assertLinkTo(
    join(file.home, '.claude', 'skills', 'nexus-setup'),
    join(file.home, '.nexus', 'skills', 'nexus-setup'),
  );
});

test('a setup that removed its lock cannot run again over its Backups', () => {
  const { home, run } = runSetup('setup_rerun', (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), []);
  });
  assert.equal(run.status, 0, run.stderr);
  rmSync(join(home, '.nexus', 'skill-lock.json'));
  const before = homeTrees(home);
  const again = runNexus(home, ['setup']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /backup already exists: .*\.claude-backup/);
  assert.match(again.stderr, /backup already exists: .*\.codex-backup/);
  assert.equal(homeTrees(home), before);
  assert.ok(isAbsent(join(home, '.nexus', '.nexus-setup.lock')));
});

test('setup with absent Agent Homes makes two empty Backups', () => {
  const { home, run } = runSetup('setup_absent_roots', (home) => {
    writeLock(join(home, '.agents', '.skill-lock.json'), []);
  });
  assert.equal(run.status, 0, run.stderr);
  for (const backup of ['.claude-backup', '.codex-backup']) {
    assert.ok(lstatSync(join(home, backup)).isDirectory());
    assert.deepEqual(readdirSync(join(home, backup)), []);
  }
});

test('setup says the same bytes and leaves the same trees as the Bash CLI', { skip: BASH_PARITY }, () => {
  const homes: readonly (readonly [string, (home: string) => void])[] = [
    ['parity_happy', happyHome],
    ['parity_backups', existingBackupsHome],
    ['parity_conflicts', conflictingHome],
    ['parity_invalid', invalidCandidateHome],
    ['parity_none', noCandidateHome],
    ['parity_broken_canonical', brokenCanonicalHome],
    ['parity_agents_symlink', symlinkedAgentsHome],
    ['parity_skill_md_symlink', symlinkedSkillFileHome],
    ['parity_nested_broken', nestedBroken],
    ['parity_nested_cyclic', nestedCyclic],
    ['parity_nested_internal', nestedInternal],
    ['parity_reserved', (home) => writeLock(join(home, '.agents', '.skill-lock.json'), ['nexus'])],
    [
      'parity_mutex',
      (home) => {
        writeLock(join(home, '.agents', '.skill-lock.json'), []);
        mkdirSync(join(home, '.nexus', '.nexus-setup.lock'));
      },
    ],
    [
      'parity_initialized',
      (home) => writeLock(join(home, '.nexus', 'skill-lock.json'), ['alpha']),
    ],
  ];
  for (const [name, build] of homes) assertSetupSameAsBash(name, build);
});

