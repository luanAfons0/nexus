/**
 * `nexus global show` and `nexus global edit`: read the Global Instructions,
 * and replace `GLOBAL.md`, the one path Nexus writes in the Custom Root
 * (ADR 0004).
 *
 * These are the global cases of the Bash suite, carried over. Its help
 * case, `global_help_lists_global`, lives in `tests/cli.test.ts`, which
 * asserts the whole help text. The link cases of its Global Instructions
 * suite live in `tests/link.test.ts` and `tests/bootstrap.test.ts`.
 *
 * On Windows each Instruction Path is a Managed Copy of `GLOBAL.md`
 * (ADR 0010): `global edit` brings both copies in step with the new file, and
 * keeps a copy edited by hand as a Foreign Entry. The cases at the end prove
 * it, and that `list` and `global show --json` call a Managed Copy linked.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { customHome, snapshotTree, writeLock, writeSkill } from './helpers/homes.ts';
import {
  agentTrees,
  assertLinkTo,
  assertManagedCopy,
  isAbsent,
  linkText,
  makeLink,
  managedCopies,
  sha256,
  WINDOWS,
} from './helpers/links.ts';
import { newHome, type Run, runNexus } from './helpers/nexus.ts';

const POSIX_ONLY = WINDOWS && 'POSIX file modes are Linux alone';
const WINDOWS_ONLY = !WINDOWS && 'only Windows makes Managed Copies';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * A home with a Custom Root, both Agent Homes, one Installed and one Custom
 * Skill, a lock, and a note in the Custom Skill that must never change, as
 * `global_cli_home` makes it.
 */
function globalHome(name: string): string {
  const home = customHome(name);
  writeSkill(join(home, '.agents', 'skills'), 'installed');
  writeSkill(join(home, '.custom-skills'), 'mine');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['installed']);
  writeFileSync(join(home, '.custom-skills', 'mine', 'notes.md'), 'custom content\n');
  return home;
}

/** The path of `GLOBAL.md` in a home. */
function owner(home: string): string {
  return join(home, '.custom-skills', 'GLOBAL.md');
}

/** Every tree a global run may touch, and the Custom Skill's bytes. */
function snapshot(home: string): string {
  const mine = join(home, '.custom-skills', 'mine');
  return [agentTrees(home), textOf(join(mine, 'SKILL.md')), textOf(join(mine, 'notes.md'))].join('\n');
}

/** The text of the file at `path`, or nothing when it cannot be read. */
function textOf(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Assert the Custom Skill beside `GLOBAL.md` is as `globalHome` wrote it. */
function assertCustomSkillIntact(home: string): void {
  const mine = join(home, '.custom-skills', 'mine');
  assert.equal(readFileSync(join(mine, 'notes.md'), 'utf8'), 'custom content\n');
  assert.ok(statSync(join(mine, 'SKILL.md')).isFile());
  assert.equal(linkText(join(mine, 'SKILL.md')), undefined);
}

/**
 * Assert an Instruction Path is the relative Managed Link
 * `../.custom-skills/GLOBAL.md`, or on Windows a Managed Copy of it.
 */
function assertInstructionLink(home: string, path: string): void {
  if (WINDOWS) return assertManagedCopy(home, path, owner(home));
  assertLinkTo(path, owner(home));
  assert.equal(linkText(path), '../.custom-skills/GLOBAL.md');
}

/** The names in `dir` that a temporary file of Nexus left. */
function residue(dir: string): readonly string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.nexus-'));
}

/** Run `global edit` with `input` on stdin, and any more arguments. */
function edit(home: string, input: string, args: readonly string[] = []): Run {
  return runNexus(home, ['global', 'edit', ...args], { input });
}

test('global show prints the bytes of GLOBAL.md as they are and changes nothing', () => {
  const home = globalHome('global_show_plain');
  writeFileSync(owner(home), 'rule one\n\nrule two');
  const before = snapshot(home);

  const run = runNexus(home, ['global', 'show']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'rule one\n\nrule two');
  assert.equal(run.stderr, '');
  assert.equal(snapshot(home), before);
  assertCustomSkillIntact(home);
});

test('global show --json prints one object with the content and both Instruction Path states', () => {
  const home = globalHome('global_show_json');
  writeFileSync(owner(home), 'rule one\n');
  writeFileSync(join(home, '.codex', 'AGENTS.md'), 'hand written\n');
  assert.equal(runNexus(home, ['link']).status, 0);

  const run = runNexus(home, ['global', 'show', '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(
    run.stdout,
    `${JSON.stringify({
      owner: owner(home),
      present: true,
      sha256: sha256(owner(home)),
      content: 'rule one\n',
      claude: 'linked',
      codex: 'foreign',
    })}\n`,
  );
  assertCustomSkillIntact(home);
});

test('global show with no GLOBAL.md prints nothing, and its JSON says absent and no home', () => {
  const home = globalHome('global_show_absent');
  rmSync(join(home, '.codex'), { recursive: true });

  const plain = runNexus(home, ['global', 'show']);
  assert.equal(plain.status, 0);
  assert.equal(plain.stdout + plain.stderr, '');

  const json = runNexus(home, ['global', 'show', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(
    json.stdout,
    `${JSON.stringify({
      owner: owner(home),
      present: false,
      sha256: null,
      content: null,
      claude: 'absent',
      codex: 'no home',
    })}\n`,
  );
  assert.ok(isAbsent(owner(home)));
  assert.ok(isAbsent(join(home, '.codex')));
});

for (const [kind, make] of [
  ['symlink', (path: string) => makeLink('mine/SKILL.md', path)],
  ['directory', (path: string) => mkdirSync(path)],
] as const) {
  test(`global show refuses a GLOBAL.md that is a ${kind} and changes nothing`, () => {
    const home = globalHome(`global_show_fault_${kind}`);
    make(owner(home));
    const before = snapshot(home);
    for (const args of [['global', 'show'], ['global', 'show', '--json']]) {
      const run = runNexus(home, args);
      assert.equal(run.status, 1, args.join(' '));
      assert.equal(run.stdout, '');
      assert.equal(
        run.stderr,
        `nexus: error: global instructions must be a regular file, not a ${kind}: ${owner(home)}\n`,
      );
      assert.equal(snapshot(home), before);
    }
  });

  test(`global edit refuses a GLOBAL.md that is a ${kind} and changes nothing`, () => {
    const home = globalHome(`global_edit_fault_${kind}`);
    make(owner(home));
    const before = snapshot(home);

    const run = edit(home, 'new rule\n');
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(
      run.stderr,
      `nexus: error: global instructions must be a regular file, not a ${kind}: ${owner(home)}\n`,
    );
    assert.equal(snapshot(home), before);
    assertCustomSkillIntact(home);
  });
}

test('global show and global edit refuse when the Custom Root is absent, and never make it', () => {
  const home = newHome('global_no_root');
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.codex'));
  const sentence = `nexus: error: custom skill root is absent: ${join(home, '.custom-skills')}\n`;
  for (const run of [
    runNexus(home, ['global', 'show']),
    runNexus(home, ['global', 'show', '--json']),
    edit(home, 'new rule\n'),
  ]) {
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, sentence);
  }
  assert.ok(isAbsent(join(home, '.custom-skills')));
  assert.ok(isAbsent(join(home, '.claude', 'CLAUDE.md')));
});

test('a Custom Root that is a file is refused as not a physical directory', () => {
  const home = newHome('global_root_file');
  writeFileSync(join(home, '.custom-skills'), '');
  for (const run of [runNexus(home, ['global', 'show']), edit(home, 'new rule\n')]) {
    assert.equal(run.status, 1);
    assert.equal(
      run.stderr,
      `nexus: error: custom skill root must be a physical directory: ${join(home, '.custom-skills')}\n`,
    );
  }
  assert.equal(readFileSync(join(home, '.custom-skills'), 'utf8'), '');
});

test('global with no action, an unknown action, or a stray argument prints the usage and exits 2', () => {
  const home = globalHome('global_usage');
  writeFileSync(owner(home), 'old rule\n');
  const before = snapshot(home);
  const usage = runNexus(home, ['help']).stdout;
  const cases: readonly (readonly [readonly string[], string])[] = [
    [['global'], ''],
    [['global', 'nope'], ''],
    [['global', 'show', '--nope'], 'global show accepts only --json'],
    [['global', 'show', 'extra'], 'global show accepts only --json'],
    [['global', 'show', '--json', 'extra'], 'global show accepts only --json'],
    [['global', 'edit', '--nope'], 'global edit accepts only --if-match <sha256>'],
    [['global', 'edit', 'extra'], 'global edit accepts only --if-match <sha256>'],
    [['global', 'edit', '--if-match'], 'global edit: --if-match requires a sha256 value'],
    [
      ['global', 'edit', '--if-match', 'nothex'],
      'global edit: --if-match requires a hex sha256, got: nothex',
    ],
  ];
  for (const [args, sentence] of cases) {
    const run = runNexus(home, args, { input: 'new rule\n' });
    assert.equal(run.status, 2, args.join(' '));
    assert.equal(run.stdout, '', args.join(' '));
    const refusal = sentence === '' ? '' : `nexus: error: ${sentence}\n`;
    assert.equal(run.stderr, refusal + usage, args.join(' '));
  }
  assert.equal(snapshot(home), before);
  assert.equal(readFileSync(owner(home), 'utf8'), 'old rule\n');
});

test('global edit makes GLOBAL.md, then links both Instruction Paths and says what link says', () => {
  const home = globalHome('global_edit_create');
  const codex = join(home, '.codex', 'AGENTS.md');
  writeFileSync(codex, 'hand written\n');

  const run = edit(home, 'first rule\n');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(
    run.stdout,
    `nexus: foreign entry at ${codex}: preserved; to manage it, run: ` +
      `mv ${codex} ${owner(home)}, then rerun link\n` +
      'nexus: link complete: skills reconciled\n',
  );
  assert.ok(statSync(owner(home)).isFile());
  assert.equal(linkText(owner(home)), undefined);
  assert.equal(readFileSync(owner(home), 'utf8'), 'first rule\n');
  assertInstructionLink(home, join(home, '.claude', 'CLAUDE.md'));
  assert.equal(readFileSync(codex, 'utf8'), 'hand written\n');
  assertLinkTo(join(home, '.claude', 'skills', 'mine'), join(home, '.custom-skills', 'mine'));
  assert.deepEqual(residue(join(home, '.custom-skills')), []);
  assertCustomSkillIntact(home);
});

test('global edit that makes GLOBAL.md in a clean home links both Instruction Paths, with no error', () => {
  const home = globalHome('global_edit_create_clean');
  const run = edit(home, 'first rule\n');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assertInstructionLink(home, join(home, '.claude', 'CLAUDE.md'));
  assertInstructionLink(home, join(home, '.codex', 'AGENTS.md'));
});

test('global edit replaces GLOBAL.md, says nothing, and writes nothing else', () => {
  const home = globalHome('global_edit_overwrite');
  writeFileSync(owner(home), 'old rule\n');
  const custom = join(home, '.custom-skills');
  const before = { agents: agentTrees(home, ['.claude', '.codex', '.agents']), custom: snapshotTree(custom) };

  const run = edit(home, 'new rule\nline two\n');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout + run.stderr, '');
  assert.equal(readFileSync(owner(home), 'utf8'), 'new rule\nline two\n');
  assert.equal(agentTrees(home, ['.claude', '.codex', '.agents']), before.agents);
  assert.deepEqual(snapshotTree(custom), before.custom);
  assert.ok(isAbsent(join(home, '.claude', 'CLAUDE.md')));
  assert.ok(isAbsent(join(home, '.codex', 'AGENTS.md')));
  assertCustomSkillIntact(home);
});

test('global edit --if-match with the sha256 that show gave replaces GLOBAL.md', () => {
  const home = globalHome('global_edit_if_match_ok');
  writeFileSync(owner(home), 'old rule\n');
  const shown = JSON.parse(runNexus(home, ['global', 'show', '--json']).stdout) as { sha256: string };

  const run = edit(home, 'new rule\n', ['--if-match', shown.sha256.toUpperCase()]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout + run.stderr, '');
  assert.equal(readFileSync(owner(home), 'utf8'), 'new rule\n');
  assertCustomSkillIntact(home);
});

test('global edit --if-match with another sha256 refuses, names both, and changes nothing', () => {
  const home = globalHome('global_edit_if_match_bad');
  writeFileSync(owner(home), 'old rule\n');
  const actual = sha256(owner(home));
  const before = snapshot(home);

  const run = edit(home, 'new rule\n', ['--if-match', EMPTY_SHA256]);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(
    run.stderr,
    'nexus: error: global instructions changed since they were read: ' +
      `expected sha256 ${EMPTY_SHA256}, actual ${actual}\n`,
  );
  assert.equal(readFileSync(owner(home), 'utf8'), 'old rule\n');
  assert.equal(snapshot(home), before);
});

test('the sha256 of nothing matches an absent GLOBAL.md and an empty one', () => {
  const home = globalHome('global_edit_empty_sha');

  const absent = edit(home, 'first rule\n', ['--if-match', EMPTY_SHA256]);
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(readFileSync(owner(home), 'utf8'), 'first rule\n');
  assertInstructionLink(home, join(home, '.claude', 'CLAUDE.md'));

  writeFileSync(owner(home), '');
  const empty = edit(home, 'second rule\n', ['--if-match', EMPTY_SHA256]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(readFileSync(owner(home), 'utf8'), 'second rule\n');
  assert.equal(empty.stdout + empty.stderr, '');
});

test('global edit with empty stdin writes an empty GLOBAL.md', () => {
  const home = globalHome('global_edit_empty_stdin');
  writeFileSync(owner(home), 'old rule\n');

  const run = edit(home, '');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(statSync(owner(home)).isFile());
  assert.equal(statSync(owner(home)).size, 0);
  assertCustomSkillIntact(home);
});

test('global edit that makes GLOBAL.md with no lock keeps the file and fails as link does', () => {
  const home = customHome('global_edit_no_lock');
  const run = edit(home, 'first rule\n');
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(
    run.stderr,
    'nexus: error: invalid version-3 lock: expected regular file at ' +
      `${join(home, '.nexus', 'skill-lock.json')}\n`,
  );
  assert.equal(readFileSync(owner(home), 'utf8'), 'first rule\n');
  assert.ok(isAbsent(join(home, '.claude', 'CLAUDE.md')));
});

test(
  'global edit keeps the mode of GLOBAL.md, and gives a new one the umask mode',
  { skip: POSIX_ONLY },
  () => {
    const home = globalHome('global_edit_mode');
    writeFileSync(owner(home), 'old rule\n');
    chmodSync(owner(home), 0o640);
    assert.equal(edit(home, 'new rule\n').status, 0);
    assert.equal(statSync(owner(home)).mode & 0o7777, 0o640);

    rmSync(owner(home));
    assert.equal(edit(home, 'first rule\n').status, 0);
    const umask = process.umask(0o022);
    process.umask(umask);
    assert.equal(statSync(owner(home)).mode & 0o7777, 0o666 & ~umask);
  },
);

test(
  'on Windows global edit brings both Managed Copies in step with the new GLOBAL.md',
  { skip: WINDOWS_ONLY },
  () => {
    const home = globalHome('windows_global_edit');
    const claude = join(home, '.claude', 'CLAUDE.md');
    const codex = join(home, '.codex', 'AGENTS.md');
    writeFileSync(owner(home), 'rule one\n');
    assert.equal(runNexus(home, ['link']).status, 0);

    const run = edit(home, 'rule two\n');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout + run.stderr, '');
    for (const path of [claude, codex]) {
      assertManagedCopy(home, path, owner(home));
      assert.equal(readFileSync(path, 'utf8'), 'rule two\n');
    }
    assert.deepEqual(managedCopies(home), { [claude]: sha256(owner(home)), [codex]: sha256(owner(home)) });
    assert.deepEqual(residue(join(home, '.claude')), []);
    assert.deepEqual(residue(join(home, '.codex')), []);
  },
);

test(
  'on Windows global edit keeps a Managed Copy edited by hand as a Foreign Entry',
  { skip: WINDOWS_ONLY },
  () => {
    const home = globalHome('windows_global_edit_foreign');
    const claude = join(home, '.claude', 'CLAUDE.md');
    const codex = join(home, '.codex', 'AGENTS.md');
    writeFileSync(owner(home), 'rule one\n');
    assert.equal(runNexus(home, ['link']).status, 0);
    writeFileSync(claude, 'rule one\nmy own rule\n');

    const run = edit(home, 'rule two\n');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout + run.stderr, '');
    assert.equal(readFileSync(claude, 'utf8'), 'rule one\nmy own rule\n');
    assertManagedCopy(home, codex, owner(home));
    assert.equal(readFileSync(codex, 'utf8'), 'rule two\n');
  },
);

test(
  'on Windows list and global show --json call a Managed Copy linked, and a hand edit foreign',
  { skip: WINDOWS_ONLY },
  () => {
    const home = globalHome('windows_global_states');
    writeFileSync(owner(home), 'rule one\n');
    assert.equal(runNexus(home, ['link']).status, 0);
    const state = () =>
      JSON.parse(runNexus(home, ['global', 'show', '--json']).stdout) as Record<string, unknown>;
    const line = () => runNexus(home, ['list']).stdout.trimEnd().split('\n').at(-1);

    assert.equal(state().claude, 'linked');
    assert.equal(state().codex, 'linked');
    assert.equal(line(), `global instructions: ${owner(home)} (claude: linked, codex: linked)`);

    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'my own rule\n');
    assert.equal(state().claude, 'foreign');
    assert.equal(line(), `global instructions: ${owner(home)} (claude: foreign, codex: linked)`);
  },
);

test(
  'global edit of an existing GLOBAL.md leaves a Managed Link to another Owner file where it points',
  { skip: POSIX_ONLY },
  () => {
    const home = globalHome('global_edit_other_owner_file');
    writeFileSync(owner(home), 'rule one\n');
    writeFileSync(join(home, '.custom-skills', 'OTHER.md'), 'other rules\n');
    symlinkSync('../.custom-skills/OTHER.md', join(home, '.claude', 'CLAUDE.md'));

    const run = edit(home, 'rule two\n');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout + run.stderr, '');
    assert.equal(linkText(join(home, '.claude', 'CLAUDE.md')), '../.custom-skills/OTHER.md');
    assert.ok(isAbsent(join(home, '.codex', 'AGENTS.md')));
  },
);

test(
  'on Windows a hand edit of GLOBAL.md leaves both Managed Copies linked until the next link',
  { skip: WINDOWS_ONLY },
  () => {
    const home = globalHome('windows_global_hand_edit');
    writeFileSync(owner(home), 'rule one\n');
    assert.equal(runNexus(home, ['link']).status, 0);
    writeFileSync(owner(home), 'rule two\n');

    const state = JSON.parse(runNexus(home, ['global', 'show', '--json']).stdout);
    assert.equal(state.claude, 'linked');
    assert.equal(state.codex, 'linked');
    const line = runNexus(home, ['list']).stdout.trimEnd().split('\n').at(-1);
    assert.equal(line, `global instructions: ${owner(home)} (claude: linked, codex: linked)`);
  },
);
