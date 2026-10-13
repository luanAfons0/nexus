/**
 * `nexus list` and `nexus list --json`: the Installed, Custom and Control
 * Skills, and the state of the Global Instructions, read and never changed.
 *
 * These are the list cases of the Bash suite, carried over. Its two help
 * cases, `help_content` and `help_rejects_extra_args`, live in
 * `tests/cli.test.ts`, which asserts the whole help text and every usage
 * refusal byte for byte.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { customHome, snapshotTree, writeLock, writeSkill } from './helpers/homes.ts';
import { newHome, runNexus } from './helpers/nexus.ts';

const SRC1 = 'owner/repo-a';
const HASH1 = '0123456789abcdef0123456789abcdef01234567';
const UPDATED1 = '2026-01-01T00:00:00Z';
const SRC2 = 'owner/repo-z';
const HASH2 = 'fedcba9876543210fedcba9876543210fedcba98';
const UPDATED2 = '2026-02-02T00:00:00Z';

const CONTROL_ROWS = [
  'nexus\tcontrol\t-\t-\t-',
  'nexus-help\tcontrol\t-\t-\t-',
  'nexus-install\tcontrol\t-\t-\t-',
  'nexus-link\tcontrol\t-\t-\t-',
  'nexus-new\tcontrol\t-\t-\t-',
  'nexus-remove\tcontrol\t-\t-\t-',
  'nexus-setup\tcontrol\t-\t-\t-',
  'nexus-update\tcontrol\t-\t-\t-',
];

const INVALID_LOCK = 'must be one JSON object with numeric version 3, object skills, and safe skill names';

/** The lock of `list_write_lock`: two Installed Skills from GitHub. */
function writeListLock(home: string): void {
  const skill = (source: string, hash: string, updated: string) => ({
    source,
    sourceType: 'github',
    skillFolderHash: hash,
    installedAt: updated,
    updatedAt: updated,
  });
  const lock = {
    version: 3,
    skills: {
      'alpha-skill': skill(SRC1, HASH1, UPDATED1),
      'zeta-skill': skill(SRC2, HASH2, UPDATED2),
    },
  };
  writeFileSync(join(home, '.nexus', 'skill-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
}

/** A symlink to a directory; a junction on Windows, which needs no privilege. */
function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, 'junction');
}

/** The names left in the Nexus home by a lock Snapshot, which must be none. */
function snapshotResidue(home: string): readonly string[] {
  return readdirSync(join(home, '.nexus')).filter((name) => name.startsWith('.nexus-lock.'));
}

type ListJson = {
  readonly skills: readonly Record<string, unknown>[];
  readonly globalInstructions: Record<string, unknown>;
};

test('list --json prints one object with every skill sorted by name, and the table stays a table', () => {
  const home = customHome('list_json');
  const custom = join(home, '.custom-skills');
  writeSkill(custom, 'middle-skill');
  writeListLock(home);
  writeFileSync(join(custom, 'GLOBAL.md'), 'rule one\n');
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'hand written\n');

  const run = runNexus(home, ['list', '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.endsWith('}\n'), true);
  assert.equal(run.stdout.split('\n').length, 2, 'one line of JSON');
  const output = JSON.parse(run.stdout) as ListJson;
  assert.deepEqual(Object.keys(output).sort(), ['globalInstructions', 'skills']);
  assert.deepEqual(
    output.skills.map((row) => row.name),
    [
      'alpha-skill',
      'middle-skill',
      'nexus',
      'nexus-help',
      'nexus-install',
      'nexus-link',
      'nexus-new',
      'nexus-remove',
      'nexus-setup',
      'nexus-update',
      'zeta-skill',
    ],
  );
  assert.deepEqual(output.skills[0], {
    name: 'alpha-skill',
    kind: 'installed',
    source: SRC1,
    hash: HASH1,
    updatedAt: UPDATED1,
  });
  assert.deepEqual(output.skills[1], {
    name: 'middle-skill',
    kind: 'custom',
    source: null,
    hash: null,
    updatedAt: null,
  });
  assert.deepEqual(output.skills[2], {
    name: 'nexus',
    kind: 'control',
    source: null,
    hash: null,
    updatedAt: null,
  });
  assert.deepEqual(output.globalInstructions, {
    owner: join(custom, 'GLOBAL.md'),
    present: true,
    sha256: createHash('sha256').update('rule one\n').digest('hex'),
    claude: 'foreign',
    codex: 'absent',
  });

  const table = runNexus(home, ['list']);
  assert.equal(table.status, 0);
  assert.ok(table.stdout.includes(`alpha-skill\tinstalled\t${SRC1}\t${HASH1.slice(0, 8)}\t${UPDATED1}\n`));
  assert.ok(!table.stdout.includes('{'));
});

test('list --json with no lock says so on stderr and keeps stdout one JSON object', () => {
  const home = customHome('list_json_no_lock');
  writeSkill(join(home, '.custom-skills'), 'only-custom');

  const run = runNexus(home, ['list', '--json']);
  assert.equal(run.status, 0);
  assert.equal(run.stderr, `nexus: lock is absent: ${join(home, '.nexus', 'skill-lock.json')}\n`);
  const output = JSON.parse(run.stdout) as ListJson;
  assert.deepEqual([...new Set(output.skills.map((row) => row.kind))].sort(), ['control', 'custom']);
  assert.equal(output.skills.find((row) => row.name === 'only-custom')?.kind, 'custom');
  assert.equal(output.globalInstructions.present, false);
  assert.equal(output.globalInstructions.sha256, null);
});

test('list --json refuses an invalid lock, a Global Instructions directory, and a stray argument', () => {
  const home = customHome('list_json_faults');
  const lock = join(home, '.nexus', 'skill-lock.json');
  writeFileSync(lock, '{"version": 2, "skills": {}}\n');
  let run = runNexus(home, ['list', '--json']);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('invalid version-3 lock'));
  assert.equal(run.stdout, '');

  unlinkSync(lock);
  mkdirSync(join(home, '.custom-skills', 'GLOBAL.md'));
  run = runNexus(home, ['list', '--json']);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('global instructions must be a regular file'));
  rmSync(join(home, '.custom-skills', 'GLOBAL.md'), { recursive: true });

  for (const args of [['list', '--nope'], ['list', '--json', 'extra']]) {
    run = runNexus(home, args);
    assert.equal(run.status, 2, args.join(' '));
    assert.ok(run.stderr.startsWith('Usage: nexus '), args.join(' '));
    assert.equal(run.stdout, '');
  }
});

/** The last line list prints: the Global Instructions line. */
function globalLine(home: string): string {
  const run = runNexus(home, ['list']);
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trimEnd().split('\n').at(-1) ?? '';
}

test('list says absent, foreign and no home for each Instruction Path, and changes nothing', () => {
  const home = customHome('list_global');
  const custom = join(home, '.custom-skills');
  const owner = join(custom, 'GLOBAL.md');
  writeFileSync(owner, 'rule one\n');

  assert.equal(globalLine(home), `global instructions: ${owner} (claude: absent, codex: absent)`);

  writeFileSync(join(home, '.codex', 'AGENTS.md'), 'hand written\n');
  const before = [home, '.claude', '.codex', '.custom-skills'].map((dir) => snapshotTree(join(home, dir)));
  assert.equal(globalLine(home), `global instructions: ${owner} (claude: absent, codex: foreign)`);
  const after = [home, '.claude', '.codex', '.custom-skills'].map((dir) => snapshotTree(join(home, dir)));
  assert.deepEqual(after, before, 'list changed the filesystem');

  rmSync(join(home, '.codex'), { recursive: true });
  assert.equal(globalLine(home), `global instructions: ${owner} (claude: absent, codex: no home)`);
  assert.deepEqual(readdirSync(home).includes('.codex'), false, 'list made the Codex Agent Home');

  unlinkSync(owner);
  assert.equal(
    globalLine(home),
    `global instructions: absent (${owner}) (claude: absent, codex: no home)`,
  );
});

test(
  'list says linked for a Managed Link to GLOBAL.md and foreign for an unrelated symlink',
  { skip: process.platform === 'win32' && 'an Instruction Path on Windows is a Managed Copy, not a symlink' },
  () => {
    const home = customHome('list_global_links');
    const custom = join(home, '.custom-skills');
    const owner = join(custom, 'GLOBAL.md');
    writeFileSync(owner, 'rule one\n');
    symlinkSync('../.custom-skills/GLOBAL.md', join(home, '.claude', 'CLAUDE.md'));
    writeFileSync(join(home, '.codex', 'AGENTS.md'), 'hand written\n');

    const before = ['.claude', '.codex', '.custom-skills'].map((dir) => snapshotTree(join(home, dir)));
    assert.equal(globalLine(home), `global instructions: ${owner} (claude: linked, codex: foreign)`);
    const after = ['.claude', '.codex', '.custom-skills'].map((dir) => snapshotTree(join(home, dir)));
    assert.deepEqual(after, before, 'list changed the filesystem');

    unlinkSync(join(home, '.codex', 'AGENTS.md'));
    symlinkSync('/unrelated/AGENTS.md', join(home, '.codex', 'AGENTS.md'));
    assert.equal(globalLine(home), `global instructions: ${owner} (claude: linked, codex: foreign)`);

    rmSync(join(home, '.codex'), { recursive: true });
    assert.equal(globalLine(home), `global instructions: ${owner} (claude: linked, codex: no home)`);

    unlinkSync(owner);
    assert.equal(
      globalLine(home),
      `global instructions: absent (${owner}) (claude: foreign, codex: no home)`,
    );
  },
);

test('list prints the header, every skill sorted by name, and the Global Instructions line', () => {
  const home = customHome('list_full');
  const custom = join(home, '.custom-skills');
  writeSkill(custom, 'middle-skill');
  writeListLock(home);

  const run = runNexus(home, ['list']);
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
  assert.equal(
    run.stdout,
    [
      'name\tkind\tsource\thash\tupdated',
      `alpha-skill\tinstalled\t${SRC1}\t${HASH1.slice(0, 8)}\t${UPDATED1}`,
      'middle-skill\tcustom\t-\t-\t-',
      ...CONTROL_ROWS,
      `zeta-skill\tinstalled\t${SRC2}\t${HASH2.slice(0, 8)}\t${UPDATED2}`,
      `global instructions: absent (${join(custom, 'GLOBAL.md')}) (claude: absent, codex: absent)`,
      '',
    ].join('\n'),
  );
  assert.deepEqual(snapshotResidue(home), []);
});

test('list with no lock says so, then lists the Custom and Control Skills', () => {
  const home = customHome('list_no_lock');
  const custom = join(home, '.custom-skills');
  writeSkill(custom, 'only-custom');

  const run = runNexus(home, ['list']);
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
  assert.equal(
    run.stdout,
    [
      `nexus: lock is absent: ${join(home, '.nexus', 'skill-lock.json')}`,
      'name\tkind\tsource\thash\tupdated',
      ...CONTROL_ROWS,
      'only-custom\tcustom\t-\t-\t-',
      `global instructions: absent (${join(custom, 'GLOBAL.md')}) (claude: absent, codex: absent)`,
      '',
    ].join('\n'),
  );
});

test('list refuses an invalid lock with one sentence and exit 1', () => {
  const home = customHome('list_invalid_lock');
  const lock = join(home, '.nexus', 'skill-lock.json');
  writeFileSync(lock, '{"version": 2, "skills": {}}\n');

  const run = runNexus(home, ['list']);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, `nexus: error: invalid version-3 lock: ${lock} ${INVALID_LOCK}\n`);
  assert.deepEqual(snapshotResidue(home), []);
});

test('list refuses an extra argument with the usage and exit 2', () => {
  const home = newHome('list_extra_args');
  const run = runNexus(home, ['list', 'extra']);
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.startsWith('Usage: nexus '));
});

test('every lock that is not an exact version-3 lock with safe Skill Names is refused the same way', () => {
  const home = customHome('list_lock_rules');
  const lock = join(home, '.nexus', 'skill-lock.json');
  const refused = [
    '',
    '   \n',
    'not json',
    '{"version":3,"skills":{}}{"version":3,"skills":{}}',
    '[]',
    '{"version":"3","skills":{}}',
    '{"version":3.5,"skills":{}}',
    '{"skills":{}}',
    '{"version":3,"skills":[]}',
    '{"version":3}',
    '{"version":3,"skills":{"../escape":{}}}',
    '{"version":3,"skills":{".":{}}}',
    '{"version":3,"skills":{"-flag":{}}}',
    '{"version":3,"skills":{"a b":{}}}',
    '{"version":3,"skills":{"tail\\n":{}}}',
    '{"version":3,"skills":{"nexus-link":{}}}',
    '{"version":3,"skills":{"__proto__":{}}}',
  ];
  for (const text of refused) {
    writeFileSync(lock, text);
    const run = runNexus(home, ['list']);
    assert.equal(run.status, 1, JSON.stringify(text));
    assert.equal(run.stdout, '', JSON.stringify(text));
    assert.equal(
      run.stderr,
      `nexus: error: invalid version-3 lock: ${lock} ${INVALID_LOCK}\n`,
      JSON.stringify(text),
    );
  }
  writeFileSync(lock, '{"version":3.0,"skills":{"constructor":{}, "a.b_c-1":{}}}');
  const run = runNexus(home, ['list']);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes('\nconstructor\tinstalled\t-\t-\t-\n'));
  assert.ok(run.stdout.includes('\na.b_c-1\tinstalled\t-\t-\t-\n'));
  assert.deepEqual(snapshotResidue(home), []);
});

test(
  'a lock that is a symlink is refused, and a directory at the lock path is an absent lock',
  { skip: process.platform === 'win32' && 'a file symlink needs Developer Mode on Windows' },
  () => {
    const home = customHome('list_lock_kinds');
    const lock = join(home, '.nexus', 'skill-lock.json');
    writeLock(join(home, 'real-lock.json'), ['alpha']);
    symlinkSync(join(home, 'real-lock.json'), lock);
    let run = runNexus(home, ['list']);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, `nexus: error: invalid version-3 lock: expected regular file at ${lock}\n`);

    unlinkSync(lock);
    mkdirSync(lock);
    run = runNexus(home, ['list']);
    assert.equal(run.status, 0);
    assert.ok(run.stdout.startsWith(`nexus: lock is absent: ${lock}\n`));
  },
);

test('every Custom Root entry that is not a valid Custom Skill is named, and list exits 1', () => {
  const home = customHome('list_custom_faults');
  const custom = join(home, '.custom-skills');
  writeSkill(custom, 'good');
  writeSkill(home, 'elsewhere');
  linkDirectory(join(home, 'elsewhere'), join(custom, 'aaa-link'));
  mkdirSync(join(custom, 'bbb bad'));
  mkdirSync(join(custom, 'ccc-missing'));
  mkdirSync(join(custom, 'ddd-folder', 'SKILL.md'), { recursive: true });
  writeSkill(custom, 'nexus-new');
  writeFileSync(join(custom, 'README.md'), 'furniture\n');
  mkdirSync(join(custom, '.git'));
  mkdirSync(join(custom, '.workspaces', 'scratch'), { recursive: true });

  const run = runNexus(home, ['list']);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, `nexus: lock is absent: ${join(home, '.nexus', 'skill-lock.json')}\n`);
  assert.equal(
    run.stderr,
    [
      `nexus: error: custom skill entry must not be a symlink: ${join(custom, 'aaa-link')}`,
      `nexus: error: unsafe custom skill name: ${join(custom, 'bbb bad')}`,
      `nexus: error: custom skill is missing SKILL.md: ${join(custom, 'ccc-missing', 'SKILL.md')}`,
      `nexus: error: custom skill is missing SKILL.md: ${join(custom, 'ddd-folder', 'SKILL.md')}`,
      `nexus: error: reserved control skill name in custom skill root: ${join(custom, 'nexus-new')}`,
      '',
    ].join('\n'),
  );
});

test(
  'a Custom Root entry that is neither a file nor a directory is unexpected',
  { skip: process.platform === 'win32' && 'Windows has no FIFO' },
  () => {
    const home = customHome('list_custom_fifo');
    const fifo = join(home, '.custom-skills', 'pipe');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const run = runNexus(home, ['list', '--json']);
    assert.equal(run.status, 1);
    assert.ok(run.stderr.endsWith(`nexus: error: unexpected entry in custom skill root: ${fifo}\n`));
    assert.equal(run.stdout, '');
  },
);

test('a Custom Root that is not a physical directory is refused before any Custom Skill is read', () => {
  const home = newHome('list_custom_root_file');
  const custom = join(home, '.custom-skills');
  writeFileSync(custom, 'not a directory\n');
  let run = runNexus(home, ['list']);
  assert.equal(run.status, 1);
  assert.equal(run.stderr, `nexus: error: custom skill root must be a physical directory: ${custom}\n`);

  unlinkSync(custom);
  mkdirSync(join(home, 'elsewhere'));
  linkDirectory(join(home, 'elsewhere'), custom);
  run = runNexus(home, ['list']);
  assert.equal(run.status, 1);
  assert.equal(run.stderr, `nexus: error: custom skill root must be a physical directory: ${custom}\n`);

  unlinkSync(custom);
  run = runNexus(home, ['list']);
  assert.equal(run.status, 0, 'an absent Custom Root is no fault');
});

test('a Global Instructions owner that is not a regular file is refused', () => {
  const home = customHome('list_owner_kinds');
  const owner = join(home, '.custom-skills', 'GLOBAL.md');
  mkdirSync(owner);
  let run = runNexus(home, ['list']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    `nexus: error: global instructions must be a regular file, not a directory: ${owner}\n`,
  );
  rmSync(owner, { recursive: true });
  mkdirSync(join(home, 'elsewhere'));
  linkDirectory(join(home, 'elsewhere'), owner);
  run = runNexus(home, ['list']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    `nexus: error: global instructions must be a regular file, not a symlink: ${owner}\n`,
  );
});

test('a Skill Name that is both Installed and Custom shows as both, custom first in the table', () => {
  const home = customHome('list_collision');
  writeSkill(join(home, '.custom-skills'), 'alpha');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['alpha']);

  const run = runNexus(home, ['list']);
  assert.equal(run.status, 0);
  assert.ok(
    run.stdout.includes('\nalpha\tcustom\t-\t-\t-\nalpha\tinstalled\ttest\ttest-has\t2026-01-01T00:00:00Z\n'),
    run.stdout,
  );
  const json = JSON.parse(runNexus(home, ['list', '--json']).stdout) as ListJson;
  assert.deepEqual(
    json.skills.slice(0, 2).map((row) => row.kind),
    ['installed', 'custom'],
  );
});

test('a missing or empty lock field shows as - in the table and keeps its JSON value', () => {
  const home = customHome('list_fields');
  const lock = {
    version: 3,
    skills: {
      bare: {},
      empty: { source: '', skillFolderHash: false, updatedAt: null },
      number: { source: 42, skillFolderHash: 'abc', updatedAt: true },
      plain: 'not an object',
      wide: { source: 'owner/ünïcode\u007f', skillFolderHash: 'f'.repeat(64) },
    },
  };
  writeFileSync(join(home, '.nexus', 'skill-lock.json'), JSON.stringify(lock));

  const run = runNexus(home, ['list']);
  assert.equal(run.status, 0);
  assert.ok(run.stdout.includes('\nbare\tinstalled\t-\t-\t-\n'));
  assert.ok(run.stdout.includes('\nempty\tinstalled\t-\t-\t-\n'));
  assert.ok(run.stdout.includes('\nnumber\tinstalled\t42\tabc\ttrue\n'));
  assert.ok(run.stdout.includes('\nplain\tinstalled\t-\t-\t-\n'));
  assert.ok(run.stdout.includes(`\nwide\tinstalled\towner/ünïcode\u007f\tffffffff\t-\n`));

  const json = runNexus(home, ['list', '--json']);
  assert.ok(json.stdout.includes('"source":"owner/ünïcode\\u007f"'), 'DEL is escaped as jq does');
  const rows = (JSON.parse(json.stdout) as ListJson).skills;
  assert.deepEqual(rows.find((row) => row.name === 'empty'), {
    name: 'empty',
    kind: 'installed',
    source: '',
    hash: null,
    updatedAt: null,
  });
  assert.deepEqual(rows.find((row) => row.name === 'number'), {
    name: 'number',
    kind: 'installed',
    source: 42,
    hash: 'abc',
    updatedAt: true,
  });
});
