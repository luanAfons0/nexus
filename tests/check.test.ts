/**
 * `nexus check` and `nexus check --last`: which Installed Skills are Behind,
 * asked of GitHub through a fake `gh`, with nothing moved but the Check
 * Result.
 *
 * These are the CLI cases of the Bash suite, carried over. Its three
 * Plugin Server cases belong to the Plugin Server's tests (#83). No case
 * reaches the network: the fake `gh` answers every call, and the cases that
 * prove a road without `gh` run on a PATH that holds no `gh`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { customHome, snapshotTree } from './helpers/homes.ts';
import { fakeCalls, installFake, runNexus } from './helpers/nexus.ts';


/** The fourth field of a gh call, the jq filter that picks the committer date. */
const DATE_FILTER = '.[0].commit.committer.date // empty';

const REASON_404 = 'could not reach owner/gone (gh exited 1): gh: Not Found (HTTP 404)';

/** A moment in the form the Check Result writes it. */
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** One skill of a test lock, from GitHub unless it says otherwise. */
function skill(source: string, skillPath: string, hash: string, updated = '2026-01-01T00:00:00Z') {
  return {
    source,
    sourceType: 'github',
    skillPath,
    skillFolderHash: hash,
    installedAt: updated,
    updatedAt: updated,
  };
}

/**
 * The lock of `check_write_lock`: two Installed Skills in one repository, one
 * in a repository the fake cannot reach, and one whose SKILL.md is the root
 * of its own.
 */
const FOUR_SKILLS = {
  'behind-skill': skill(
    'owner/moved',
    'skills/behind-skill/SKILL.md',
    'aaaa',
    '2026-01-01T00:00:00.500Z',
  ),
  'current-skill': skill('owner/quiet', 'skills/current-skill/SKILL.md', 'bbbb'),
  'unreachable-skill': skill('owner/gone', 'skills/unreachable-skill/SKILL.md', 'cccc'),
  'whole-repository-skill': skill('owner/moved', 'SKILL.md', 'dddd'),
};

function lockPath(home: string): string {
  return join(home, '.nexus', 'skill-lock.json');
}

function resultPath(home: string): string {
  return join(home, '.nexus', 'skill-check.json');
}

function writeCheckLock(home: string, skills: Readonly<Record<string, unknown>> = FOUR_SKILLS) {
  writeFileSync(lockPath(home), `${JSON.stringify({ version: 3, skills }, null, 2)}\n`);
}

/** A home with the four-skill lock and the fake `gh` first on PATH. */
function checkHome(name: string): string {
  const home = customHome(name);
  installFake(home, 'gh', 'gh-check.ts');
  writeCheckLock(home);
  return home;
}

/** Take the fake `gh` off PATH again; the calls it recorded stay. */
function removeGh(home: string): void {
  for (const name of ['gh', 'gh.cmd']) rmSync(join(home, 'fakebin', name), { force: true });
}

/** A run with a PATH that holds the home's fake programs and nothing else. */
const ONLY_FAKES = { env: { PATH: '' } };

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** What a check could move: the lock and every skill and link of both agents. */
function agentState(home: string) {
  return {
    lock: sha256(lockPath(home)),
    trees: ['.claude', '.codex', '.agents'].map((dir) => snapshotTree(join(home, dir))),
  };
}

function scratch(home: string): readonly string[] {
  return readdirSync(join(home, '.nexus')).filter((name) => name.startsWith('.nexus-tmp.'));
}

type Row = Readonly<Record<string, unknown>>;
type Result = {
  readonly checkedAt: string;
  readonly counts: Row;
  readonly skills: readonly Row[];
};

function readResult(home: string): Result {
  return JSON.parse(readFileSync(resultPath(home), 'utf8')) as Result;
}

/** The table a check of the four skills prints, for a result checked at `at`. */
function fourSkillTable(home: string, at: string): string {
  return [
    'name\tstate\tsource\tupdated\tupstream',
    'behind-skill\tbehind\towner/moved\t2026-01-01T00:00:00.500Z\t2026-06-01T10:00:00Z',
    'current-skill\tcurrent\towner/quiet\t2026-01-01T00:00:00Z\t2025-06-01T10:00:00Z',
    'unreachable-skill\tunknown\towner/gone\t2026-01-01T00:00:00Z\t-',
    'whole-repository-skill\tbehind\towner/moved\t2026-01-01T00:00:00Z\t2026-06-01T10:00:00Z',
    `unknown unreachable-skill: ${REASON_404}`,
    `checked at ${at}: 1 current, 2 behind, 1 unknown (${resultPath(home)})`,
    '',
  ].join('\n');
}

test('check says which Installed Skills are current, Behind and unknown, and moves nothing', () => {
  const home = checkHome('check-states');
  const before = agentState(home);

  const run = runNexus(home, ['check']);
  assert.equal(run.stderr, '');
  assert.equal(run.status, 0);
  const result = readResult(home);
  assert.match(result.checkedAt, MOMENT);
  assert.equal(run.stdout, fourSkillTable(home, result.checkedAt));

  // GitHub is asked about the Skill's folder, about the whole repository when
  // the Skill is the whole repository, and grouped by repository.
  const commits = (source: string, folder?: string) => [
    'api',
    '-X',
    'GET',
    `repos/${source}/commits`,
    '-f',
    'per_page=1',
    ...(folder === undefined ? [] : ['-f', `path=${folder}`]),
    '--jq',
    DATE_FILTER,
  ];
  assert.deepEqual(fakeCalls(home, 'gh'), [
    ['auth', 'status'],
    commits('owner/gone', 'skills/unreachable-skill'),
    commits('owner/moved', 'skills/behind-skill'),
    commits('owner/moved'),
    commits('owner/quiet', 'skills/current-skill'),
  ]);

  // The check applies nothing, and leaves no scratch behind.
  assert.deepEqual(agentState(home), before);
  assert.deepEqual(scratch(home), []);

  // The result is Nexus's own file, beside the lock and never inside it.
  assert.deepEqual(result.counts, { current: 1, behind: 2, unknown: 1 });
  assert.deepEqual(result.skills, [
    {
      name: 'behind-skill',
      state: 'behind',
      source: 'owner/moved',
      folder: 'skills/behind-skill',
      updatedAt: '2026-01-01T00:00:00.500Z',
      committedAt: '2026-06-01T10:00:00Z',
      reason: null,
    },
    {
      name: 'current-skill',
      state: 'current',
      source: 'owner/quiet',
      folder: 'skills/current-skill',
      updatedAt: '2026-01-01T00:00:00Z',
      committedAt: '2025-06-01T10:00:00Z',
      reason: null,
    },
    {
      name: 'unreachable-skill',
      state: 'unknown',
      source: 'owner/gone',
      folder: 'skills/unreachable-skill',
      updatedAt: '2026-01-01T00:00:00Z',
      committedAt: null,
      reason: REASON_404,
    },
    {
      name: 'whole-repository-skill',
      state: 'behind',
      source: 'owner/moved',
      folder: '',
      updatedAt: '2026-01-01T00:00:00Z',
      committedAt: '2026-06-01T10:00:00Z',
      reason: null,
    },
  ]);
});

test('check --json prints the document the Check Result holds, in jq pretty form', () => {
  const home = checkHome('check-json');
  const run = runNexus(home, ['check', '--json']);
  assert.equal(run.stderr, '');
  assert.equal(run.status, 0);
  const file = readFileSync(resultPath(home), 'utf8');
  assert.equal(run.stdout, file);
  assert.equal(file, `${JSON.stringify(JSON.parse(file), null, 2)}\n`);
  assert.deepEqual(Object.keys(JSON.parse(file) as object), ['checkedAt', 'counts', 'skills']);
});

test('every unknown Installed Skill carries the reason, and none counts as current', () => {
  const home = customHome('check-reasons');
  installFake(home, 'gh', 'gh-check.ts');
  const {
    installedAt: _installed,
    updatedAt: _updated,
    ...undated
  } = skill('owner/quiet', 'skills/undated/SKILL.md', 'eeee');
  writeCheckLock(home, {
    local: { ...skill('owner/quiet', 'skills/local/SKILL.md', 'ffff'), sourceType: 'local' },
    nameless: { ...skill('', 'skills/nameless/SKILL.md', 'ffff') },
    undated,
    'installed-only': { ...skill('owner/quiet', 'x/SKILL.md', 'ffff'), updatedAt: null },
    silent: skill('owner/empty', 'skills/silent/SKILL.md', 'ffff'),
    'silent-root': skill('owner/empty', 'SKILL.md', 'ffff'),
    odd: skill('owner/odd', 'skills/odd/SKILL.md', 'ffff'),
  });

  const run = runNexus(home, ['check']);
  assert.equal(run.status, 0);
  const result = readResult(home);
  const rows = new Map(result.skills.map((row) => [row.name, row]));
  assert.equal(rows.get('installed-only')?.state, 'current');
  assert.equal(rows.get('installed-only')?.updatedAt, '2026-01-01T00:00:00Z');
  const reasons = Object.fromEntries(
    result.skills.filter((row) => row.state === 'unknown').map((row) => [row.name, row.reason]),
  );
  assert.deepEqual(reasons, {
    local: 'the lock records no GitHub repository for local',
    nameless: 'the lock records no GitHub repository for nameless',
    odd: 'cannot compare 2026-01-01T00:00:00Z with not a moment',
    silent: 'no commit in owner/empty touches skills/silent',
    'silent-root': 'no commit in owner/empty touches the repository',
    undated: 'the lock records no install date for undated',
  });
  assert.equal(rows.get('odd')?.committedAt, 'not a moment');
  assert.equal(rows.get('nameless')?.source, null);
  assert.equal(rows.get('undated')?.updatedAt, null);
  assert.deepEqual(result.counts, { current: 1, behind: 0, unknown: 6 });
  assert.match(run.stdout, /\nunknown local: the lock records no GitHub repository for local\n/);
  assert.match(run.stdout, /: 1 current, 0 behind, 6 unknown \(/);
});

test('a folder with spaces, quotes and shell characters reaches gh exactly', () => {
  const home = customHome('check-odd-folder');
  installFake(home, 'gh', 'gh-check.ts');
  const folder = 'odd folder/a & b | c > d < e ^ f %PATH% !x! "q" \\"r\\ (s) [t], u; *?\\';
  writeCheckLock(home, { odd: skill('owner/quiet', `${folder}/SKILL.md`, 'ffff') });

  const run = runNexus(home, ['check']);
  assert.equal(run.stderr, '');
  assert.equal(run.status, 0);
  assert.deepEqual(fakeCalls(home, 'gh')[1], [
    'api',
    '-X',
    'GET',
    'repos/owner/quiet/commits',
    '-f',
    'per_page=1',
    '-f',
    `path=${folder}`,
    '--jq',
    DATE_FILTER,
  ]);
  assert.equal(readResult(home).skills[0]?.state, 'current');
});

test('check refuses without gh, and writes no Check Result', () => {
  const home = customHome('check-no-gh');
  writeCheckLock(home);
  const run = runNexus(home, ['check'], ONLY_FAKES);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(
    run.stderr,
    'nexus: error: the GitHub CLI is not available: install gh, then run gh auth login\n',
  );
  assert.ok(!existsSync(resultPath(home)));
});

test('check refuses when gh is not logged in, and asks GitHub nothing', () => {
  const home = checkHome('check-logged-out');
  const run = runNexus(home, ['check'], { env: { NEXUS_FAKE_GH_MODE: 'logged_out' } });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'nexus: error: the GitHub CLI is not logged in: run gh auth login\n');
  assert.deepEqual(fakeCalls(home, 'gh'), [['auth', 'status']]);
  assert.ok(!existsSync(resultPath(home)));
});

test('check refuses without a lock, and with an invalid one', () => {
  const home = customHome('check-no-lock');
  installFake(home, 'gh', 'gh-check.ts');
  let run = runNexus(home, ['check']);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, `nexus: error: lock is absent: ${lockPath(home)}\n`);
  assert.ok(!existsSync(resultPath(home)));

  writeFileSync(lockPath(home), '{"version": 2, "skills": {}}\n');
  run = runNexus(home, ['check']);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(
    run.stderr,
    `nexus: error: invalid version-3 lock: ${lockPath(home)} must be one JSON object with ` +
      'numeric version 3, object skills, and safe skill names\n',
  );
  assert.ok(!existsSync(resultPath(home)));
  assert.deepEqual(scratch(home), []);
  assert.deepEqual(fakeCalls(home, 'gh'), [
    ['auth', 'status'],
    ['auth', 'status'],
  ]);
});

test('check refuses an argument it does not know with the usage', () => {
  const home = checkHome('check-usage');
  const usage = runNexus(home, ['help']).stdout;
  assert.match(usage, /^Usage: nexus /);
  for (const args of [['--all'], ['--json', '--bogus'], ['--last', 'now']]) {
    const run = runNexus(home, ['check', ...args]);
    assert.equal(run.status, 2, args.join(' '));
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, usage);
  }
  assert.deepEqual(fakeCalls(home, 'gh'), []);
});

test('check --last prints the last result without asking GitHub', () => {
  const home = checkHome('check-last');
  assert.equal(runNexus(home, ['check']).status, 0);
  const asked = fakeCalls(home, 'gh').length;
  const file = readFileSync(resultPath(home), 'utf8');
  const at = readResult(home).checkedAt;
  removeGh(home);

  let run = runNexus(home, ['check', '--last'], ONLY_FAKES);
  assert.equal(run.stderr, '');
  assert.equal(run.status, 0);
  assert.equal(run.stdout, fourSkillTable(home, at));

  run = runNexus(home, ['check', '--last', '--json'], ONLY_FAKES);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, file);

  // The answer is about the moment the check ran, so a lock that has moved
  // since, or gone, does not stop it from being read.
  rmSync(lockPath(home));
  run = runNexus(home, ['check', '--json', '--last'], ONLY_FAKES);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, file);
  assert.equal(fakeCalls(home, 'gh').length, asked);
});

test('check --last --json prints a compact result in jq pretty form', () => {
  const home = customHome('check-last-compact');
  const document = {
    checkedAt: '2026-01-01T00:00:00Z',
    counts: { current: 0, behind: 0, unknown: 0 },
    skills: [],
    extra: { kept: ['as', 'it', 'is'] },
  };
  writeFileSync(resultPath(home), JSON.stringify(document));
  const run = runNexus(home, ['check', '--last', '--json'], ONLY_FAKES);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, `${JSON.stringify(document, null, 2)}\n`);
});

test('check --last refuses a result that is not there, or not a result', () => {
  const home = customHome('check-last-refusals');
  writeCheckLock(home);
  const result = resultPath(home);

  let run = runNexus(home, ['check', '--last'], ONLY_FAKES);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(
    run.stderr,
    `nexus: error: no check has run yet: run nexus check to write ${result}\n`,
  );
  assert.ok(!existsSync(result));

  // Half a file, and a whole JSON document that is not a Check Result, are
  // both unreadable, and neither is corrected in place.
  const unreadable =
    `nexus: error: the check result is unreadable: ` +
    `run nexus check to write ${result} again\n`;
  for (const text of [
    'half a result\n',
    '{"checkedAt":"2026-01-01T00:00:00Z"}\n',
    '{"checkedAt":1,"counts":{},"skills":[]}\n',
    '{"checkedAt":"x","counts":[],"skills":[]}\n',
    '{"checkedAt":"x","counts":{},"skills":{}}\n',
    '[]\n',
    '',
  ]) {
    writeFileSync(result, text);
    for (const args of [['--last'], ['--last', '--json']]) {
      run = runNexus(home, ['check', ...args], ONLY_FAKES);
      assert.equal(run.status, 1, text);
      assert.equal(run.stdout, '', text);
      assert.equal(run.stderr, unreadable, text);
      assert.equal(readFileSync(result, 'utf8'), text);
    }
  }
});

test('a moment with no zone is read as UTC, whatever zone the machine is in', () => {
  // owner/moved last changed at 2026-06-01T10:00:00Z.
  const skills = {
    'early-skill': skill(
      'owner/moved',
      'skills/early-skill/SKILL.md',
      'aaaa',
      '2026-06-01 09:00:00',
    ),
    'late-skill': skill('owner/moved', 'skills/late-skill/SKILL.md', 'bbbb', '2026-06-01 11:00:00'),
  };
  for (const zone of ['America/Sao_Paulo', 'Asia/Tokyo']) {
    const home = customHome(`check-utc-${zone.replace('/', '-')}`);
    installFake(home, 'gh', 'gh-check.ts');
    writeCheckLock(home, skills);
    const run = runNexus(home, ['check'], { env: { TZ: zone } });
    assert.equal(run.status, 0, run.stderr);
    const states = readResult(home).skills.map((row) => [row.name, row.state]);
    assert.deepEqual(
      states,
      [
        ['early-skill', 'behind'],
        ['late-skill', 'current'],
      ],
      zone,
    );
  }
});
