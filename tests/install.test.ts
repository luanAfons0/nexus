/**
 * `nexus install`: run `npx skills add` through a fake `npx`, Publish the
 * Upstream Lock it wrote, and link.
 *
 * These are the install cases of `tests/run.sh`
 * (`install_cli_and_nvm_fallback`, `install_rejects_custom_collision`),
 * carried over, with more refusals of the Publish flow. The two cases that
 * need a fault point (`install_snapshot_mutate`, `install_cleanup_fail`)
 * wait for #82. No case reaches the network: the fake `npx` writes the
 * Canonical Root and the Upstream Lock as upstream would. On Linux the same
 * homes also run through the Bash CLI, and the bytes are compared, because
 * the Bash CLI is the specification.
 *
 * A case that ends in a link skips on Windows until Link has junctions and
 * Managed Copies (#76). Every refusal before the link runs on Windows too,
 * and there the fake is found as `npx.cmd`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { customHome, writeLock, writeSkill } from './helpers/homes.ts';
import { agentTrees, assertLinkTo, withoutToolNoise } from './helpers/links.ts';
import {
  fakeCalls,
  fakePath,
  installFake,
  newHome,
  REPO_ROOT,
  type Run,
  runNexus,
} from './helpers/nexus.ts';

const WINDOWS = process.platform === 'win32';
const UNTIL_JUNCTIONS = WINDOWS && 'link refuses on Windows until it has junctions (#76)';

/** The arguments `npx` gets for `install source --skill alpha --skill beta`. */
const ADD_ALPHA_BETA = [
  '--yes',
  'skills',
  'add',
  'source',
  '--global',
  '--agent',
  'universal',
  '--skill',
  'alpha',
  '--skill',
  'beta',
  '--yes',
];

/** One parity scene: the arguments, the fake's mode, and what the home holds first. */
type Scene = {
  readonly args: readonly string[];
  readonly mode?: string;
  readonly fill?: (home: string) => void;
};

/** A home with the install fake first on its PATH. */
function installHome(name: string): string {
  const home = newHome(name);
  installFake(home, 'npx', 'npx-install.ts');
  return home;
}

/** Every install scratch file left in the Nexus home. */
function scratch(home: string): readonly string[] {
  return readdirSync(join(home, '.nexus')).filter((name) => name.startsWith('.nexus-install-'));
}

/** The full path of `name` on the test's own PATH, or undefined. */
function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    try {
      if (dir !== '' && statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}

test(
  'install runs npx skills add with every skill, publishes the Upstream Lock and links',
  { skip: UNTIL_JUNCTIONS },
  () => {
    const home = installHome('install-cli');
    const run = runNexus(home, ['install', 'source', '--skill', 'alpha', '--skill', 'beta'], {
      env: { XDG_STATE_HOME: join(home, 'state') },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(fakeCalls(home, 'npx'), [ADD_ALPHA_BETA]);
    assert.ok(!existsSync(join(home, 'npx-state-home')), 'npx was given XDG_STATE_HOME');
    assert.deepEqual(
      readFileSync(join(home, '.nexus', 'skill-lock.json')),
      readFileSync(join(home, '.agents', '.skill-lock.json')),
    );
    const canonical = join(home, '.agents', 'skills');
    assertLinkTo(join(home, '.claude', 'skills', 'alpha'), join(canonical, 'alpha'));
    assertLinkTo(join(home, '.codex', 'skills', 'beta'), join(canonical, 'beta'));
    assert.equal(
      run.stdout,
      `nexus: global instructions are absent: ${join(home, '.custom-skills', 'GLOBAL.md')} ` +
        '(create it and rerun link to link the Instruction Paths)\n' +
        'nexus: link complete: skills reconciled\n' +
        ['alpha', 'beta']
          .map(
            (name) =>
              `nexus: installed ${name}: canonical ${join(canonical, name)}; ` +
              `Claude ${join(home, '.claude', 'skills', name)}; ` +
              `Codex ${join(home, '.codex', 'skills', name)}\n`,
          )
          .join(''),
    );
    assert.deepEqual(scratch(home), []);
  },
);

test('a failed npx keeps the Nexus Lock and names the untracked skill directory', () => {
  const home = installHome('install-failure');
  writeFileSync(join(home, '.nexus', 'skill-lock.json'), 'original');
  const run = runNexus(home, ['install', 'source', '--skill', 'alpha'], {
    env: { NEXUS_FAKE_NPX_MODE: 'failure' },
  });
  assert.equal(run.status, 42);
  assert.equal(run.stderr, 'nexus: error: upstream skill installation failed (status 42)\n');
  assert.equal(
    run.stdout,
    `nexus: untracked canonical skill directory: ${join(home, '.agents', 'skills', 'alpha')}\n`,
  );
  assert.equal(readFileSync(join(home, '.nexus', 'skill-lock.json'), 'utf8'), 'original');
  assert.equal(fakeCalls(home, 'npx').length, 1);
  assert.deepEqual(scratch(home), []);
});

test('a bad argument is refused with exit 2 before npx is started', () => {
  const home = installHome('install-usage');
  const cases: readonly (readonly [readonly string[], string])[] = [
    [['-bogus', '--skill', 'alpha'], 'unknown install flag: -bogus'],
    [['source', '--', '--skill', 'alpha'], 'unknown install flag: --'],
    [[], 'install requires one source'],
    [['--skill', 'alpha'], 'install requires one source'],
    [['source'], 'install requires at least one --skill NAME'],
    [['one', 'two', '--skill', 'alpha'], 'install accepts exactly one source'],
    [['source', '--skill'], 'install requires --skill NAME with a safe, non-control skill name'],
    [
      ['source', '--skill', '-x'],
      'install requires --skill NAME with a safe, non-control skill name',
    ],
    [
      ['source', '--skill', '../escape'],
      'install requires --skill NAME with a safe, non-control skill name',
    ],
    [
      ['source', '--skill', 'nexus-link'],
      'install requires --skill NAME with a safe, non-control skill name',
    ],
  ];
  for (const [args, sentence] of cases) {
    const run = runNexus(home, ['install', ...args]);
    assert.equal(run.status, 2, args.join(' '));
    assert.equal(run.stdout, '', args.join(' '));
    assert.equal(run.stderr, `nexus: error: ${sentence}\n`, args.join(' '));
  }
  assert.deepEqual(fakeCalls(home, 'npx'), []);
  assert.ok(!existsSync(join(home, '.nexus', 'skill-lock.json')));
});

test('an Upstream Lock that cannot be Published leaves the Nexus Lock byte-identical', () => {
  const lockPath = (home: string) => join(home, '.agents', '.skill-lock.json');
  const snapshotSentence = (home: string) =>
    new RegExp(
      '^nexus: error: invalid version-3 lock: ' +
        `${escape(join(home, '.nexus', '.nexus-install-lock.'))}` +
        '[A-Za-z0-9]{6} must be one JSON object with numeric version 3, object skills, and safe ' +
        'skill names\nnexus: error: upstream did not produce a valid version-3 skill lock\n$',
    );
  const cases: Readonly<Record<string, (home: string) => string | RegExp>> = {
    empty: () => 'nexus: error: upstream skill lock selected no skills\n',
    invalid: snapshotSentence,
    bad: snapshotSentence,
    'missing-skill-md': (home) =>
      'nexus: error: upstream lock skill is missing SKILL.md: ' +
      `${join(home, '.agents', 'skills', 'beta', 'SKILL.md')}\n`,
    'no-lock': (home) => `nexus: error: cannot snapshot upstream skill lock: ${lockPath(home)}\n`,
  };
  for (const [mode, expected] of Object.entries(cases)) {
    const home = installHome(`install-refused-${mode}`);
    writeLock(join(home, '.nexus', 'skill-lock.json'), ['kept']);
    const before = readFileSync(join(home, '.nexus', 'skill-lock.json'));
    const run = runNexus(home, ['install', 'source', '--skill', 'alpha'], {
      env: { NEXUS_FAKE_NPX_MODE: mode },
    });
    assert.equal(run.status, 1, mode);
    assert.equal(run.stdout, '', mode);
    const sentence = expected(home);
    if (typeof sentence === 'string') assert.equal(run.stderr, sentence, mode);
    else assert.match(run.stderr, sentence, mode);
    assert.deepEqual(readFileSync(join(home, '.nexus', 'skill-lock.json')), before, mode);
    assert.deepEqual(scratch(home), [], mode);
    assert.deepEqual(
      readdirSync(join(home, '.nexus')).filter((name) => name.startsWith('.nexus-lock.')),
      [],
      mode,
    );
    assert.ok(!existsSync(join(home, '.claude')), mode);
  }
});

test('with no npx on PATH and no NVM, install says so and changes nothing', () => {
  const home = newHome('install-no-npx');
  const run = runNexus(home, ['install', 'source', '--skill', 'alpha'], {
    env: { PATH: '', NVM_DIR: join(home, '.no-nvm') },
  });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'nexus: error: npx is unavailable and NVM was not found\n');
  assert.ok(!existsSync(join(home, '.nexus', 'skill-lock.json')));
});

test(
  'with no npx on PATH, install finds it through NVM, in bash or in sh',
  { skip: WINDOWS && 'the NVM fallback is for Linux and macOS' },
  () => {
    const bash = onPath('bash');
    const shells: Readonly<Record<string, string | undefined>> = { bash, sh: undefined };
    for (const [shell, program] of Object.entries(shells)) {
      if (shell === 'bash' && program === undefined) continue;
      const home = installHome(`install-nvm-${shell}`);
      mkdirSync(join(home, 'nvm-bin'));
      renameSync(join(home, 'fakebin', 'npx'), join(home, 'nvm-bin', 'npx'));
      rmSync(join(home, 'fakebin', 'npx.cmd'));
      mkdirSync(join(home, '.nvm'));
      writeFileSync(
        join(home, '.nvm', 'nvm.sh'),
        'nvm() { PATH="$HOME/nvm-bin:$PATH"; export PATH; }\n',
      );
      // A PATH that holds the shell at most, so npx can only come from NVM.
      mkdirSync(join(home, 'onlybin'));
      if (program !== undefined) symlinkSync(program, join(home, 'onlybin', 'bash'));
      const run = runNexus(home, ['install', 'source', '--skill', 'alpha'], {
        env: { PATH: join(home, 'onlybin'), NVM_DIR: '' },
      });
      assert.equal(run.status, 0, `${shell}: ${run.stderr}`);
      assert.match(run.stdout, /nexus: installed alpha: /, shell);
      assert.equal(fakeCalls(home, 'npx').length, 1, shell);
    }
  },
);

test(
  'when NVM loads but gives no npx, install says so',
  { skip: WINDOWS && 'the NVM fallback is for Linux and macOS' },
  () => {
    const home = newHome('install-nvm-without-npx');
    mkdirSync(join(home, 'nvm'));
    writeFileSync(join(home, 'nvm', 'nvm.sh'), 'nvm() { return 0; }\n');
    const run = runNexus(home, ['install', 'source', '--skill', 'alpha'], {
      env: { PATH: '', NVM_DIR: join(home, 'nvm') },
    });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, 'nexus: error: NVM loaded but npx is unavailable\n');
  },
);

test('install refuses a name a Custom Skill owns before npx, and a Control Skill name', () => {
  const home = customHome('install-custom-collision');
  writeSkill(join(home, '.custom-skills'), 'mine');
  writeLock(join(home, '.nexus', 'skill-lock.json'), []);
  const before = readFileSync(join(home, '.nexus', 'skill-lock.json'));
  // A PATH without npx proves the refusal comes before npx is looked for.
  const run = runNexus(home, ['install', '/some/source', '--skill', 'mine'], {
    env: { PATH: '', NVM_DIR: join(home, '.no-nvm') },
  });
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    'nexus: error: install skill collides with a custom skill: mine ' +
      `(${join(home, '.custom-skills', 'mine')})\n`,
  );
  assert.ok(!run.stderr.includes('npx'));
  for (const reserved of ['nexus-new', 'nexus-help', 'nexus-update', 'nexus-remove', 'nexus']) {
    const refused = runNexus(home, ['install', '/some/source', '--skill', reserved]);
    assert.equal(refused.status, 2, reserved);
    assert.match(refused.stderr, /non-control skill name/, reserved);
  }
  assert.deepEqual(readFileSync(join(home, '.nexus', 'skill-lock.json')), before);
});

test('a malformed Custom Root is refused before npx', () => {
  const home = installHome('install-custom-root');
  writeFileSync(join(home, '.custom-skills'), '');
  const run = runNexus(home, ['install', 'source', '--skill', 'alpha']);
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr,
    'nexus: error: custom skill root must be a physical directory: ' +
      `${join(home, '.custom-skills')}\n`,
  );
  assert.deepEqual(fakeCalls(home, 'npx'), []);
});

test(
  'install says the same bytes and leaves the same files as the Bash CLI',
  { skip: WINDOWS && 'the Bash CLI runs on Linux alone' },
  () => {
    const scenes: Readonly<Record<string, Scene>> = {
      success: { args: ['source', '--skill', 'alpha', '--skill', 'beta'] },
      failure: { args: ['source', '--skill', 'alpha'], mode: 'failure' },
      empty: { args: ['source', '--skill', 'alpha'], mode: 'empty' },
      invalid: { args: ['source', '--skill', 'alpha'], mode: 'invalid' },
      bad: { args: ['source', '--skill', 'alpha'], mode: 'bad' },
      'missing-skill-md': { args: ['source', '--skill', 'alpha'], mode: 'missing-skill-md' },
      'no-lock': { args: ['source', '--skill', 'alpha'], mode: 'no-lock' },
      'bad-flag': { args: ['-bogus', '--skill', 'alpha'] },
      collision: {
        args: ['source', '--skill', 'mine'],
        fill: (home) => writeSkill(join(home, '.custom-skills'), 'mine'),
      },
      'link-fault': {
        args: ['source', '--skill', 'alpha'],
        fill: (home) => mkdirSync(join(home, '.claude', 'skills', 'alpha')),
      },
    };
    for (const [name, scene] of Object.entries(scenes)) {
      const bash = customHome(`install-bash-${name}`);
      const node = customHome(`install-node-${name}`);
      for (const home of [bash, node]) {
        installFake(home, 'npx', 'npx-install.ts');
        writeLock(join(home, '.nexus', 'skill-lock.json'), ['kept']);
        scene.fill?.(home);
      }
      const env: Readonly<Record<string, string>> =
        scene.mode === undefined ? {} : { NEXUS_FAKE_NPX_MODE: scene.mode };
      const expected = runBashWithFakes(bash, ['install', ...scene.args], env);
      const actual = runNexus(node, ['install', ...scene.args], { env });
      const same = (text: string, home: string) =>
        text
          .replaceAll(home, '<home>')
          .replace(/\.nexus-install-lock\.[A-Za-z0-9]{6}/g, '<snapshot>');
      assert.equal(actual.status, expected.status, name);
      assert.equal(same(actual.stdout, node), same(expected.stdout, bash), name);
      assert.equal(
        same(actual.stderr, node),
        same(withoutCopyNoise(withoutToolNoise(expected.stderr)), bash),
        name,
      );
      assert.equal(same(agentTrees(node), node), same(agentTrees(bash), bash), name);
      assert.deepEqual(
        readFileSync(join(node, '.nexus', 'skill-lock.json')),
        readFileSync(join(bash, '.nexus', 'skill-lock.json')),
        name,
      );
      assert.deepEqual(scratch(node), scratch(bash), name);
    }
  },
);

/** Run the Bash CLI on a test home with its fake programs first on PATH. */
function runBashWithFakes(
  home: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>>,
): Run {
  const result = spawnSync('bash', [join(REPO_ROOT, 'scripts', 'nexus'), ...args], {
    cwd: home,
    env: {
      ...process.env,
      ...extra,
      PATH: fakePath(home, process.env.PATH ?? ''),
      HOME: home,
      NEXUS_HOME: join(home, '.nexus'),
      LC_ALL: 'C',
    },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The Bash CLI's stderr without what `cp` says of its own when it fails. */
function withoutCopyNoise(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !line.startsWith('cp: '))
    .join('\n');
}

/** `text` with every character a regular expression reads as syntax made plain. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
