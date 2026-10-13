/**
 * The CLI entry and its dispatch: help, the usage refusal, and the refusal of
 * a Node that is too old. The Bash CLI is the specification, so on Linux the
 * same arguments are also run through `scripts/nexus` and the bytes compared.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { newHome, REPO_ROOT, runNexus } from './helpers/nexus.ts';

const HELP = `Usage: nexus <bootstrap|setup|link|install|update|remove|new|list|check|global|help>

bootstrap    Link only the Nexus control skills.
setup        Run one-time initialization with backups.
link         Reconcile Claude and Codex links from the lock.
install      Install selected skills from one source via upstream npx skills.
update       Update one installed skill and relink.
remove       Uninstall one installed skill and relink.
new          Reserve a custom skill directory.
list         Show installed, custom, and control skills: list [--json].
check        Ask GitHub which installed skills are behind: check [--json]; the last result: check --last [--json].
global       Show or replace the Global Instructions: global show [--json], global edit [--if-match <sha256>].
help         Show this text.
`;

/** Arguments the dispatch refuses before any command runs. */
const USAGE_REFUSALS: readonly (readonly string[])[] = [
  [],
  ['nope'],
  [''],
  ['help', 'extra'],
  ['-h', 'extra'],
  ['--help', 'extra'],
  ['bootstrap', 'extra'],
  ['setup', 'extra'],
  ['link', 'extra'],
];

test('help, -h and --help print the usage on stdout and exit 0', () => {
  const home = newHome('help');
  for (const word of ['help', '-h', '--help']) {
    const run = runNexus(home, [word]);
    assert.equal(run.status, 0, word);
    assert.equal(run.stdout, HELP, word);
    assert.equal(run.stderr, '', word);
  }
});

test('a missing command, an unknown one, or an extra argument prints the usage on stderr and exits 2', () => {
  const home = newHome('usage');
  for (const args of USAGE_REFUSALS) {
    const run = runNexus(home, args);
    assert.equal(run.status, 2, JSON.stringify(args));
    assert.equal(run.stdout, '', JSON.stringify(args));
    assert.equal(run.stderr, HELP, JSON.stringify(args));
  }
});

test(
  'help and every usage refusal say the same bytes as the Bash CLI',
  { skip: process.platform === 'win32' && 'the Bash CLI runs on Linux alone' },
  () => {
    const home = newHome('same-as-bash');
    for (const args of [['help'], ['-h'], ['--help'], ...USAGE_REFUSALS]) {
      const bash = spawnSync('bash', [join(REPO_ROOT, 'scripts', 'nexus'), ...args], {
        cwd: home,
        env: { ...process.env, HOME: home, NEXUS_HOME: join(home, '.nexus') },
        encoding: 'utf8',
      });
      const node = runNexus(home, args);
      assert.equal(node.status, bash.status, JSON.stringify(args));
      assert.equal(node.stdout, bash.stdout, JSON.stringify(args));
      assert.equal(node.stderr, bash.stderr, JSON.stringify(args));
    }
  },
);

test('below Node 24 the CLI refuses with one sentence that names the version it needs', () => {
  const home = newHome('old-node');
  const older =
    'data:text/javascript,Object.defineProperty(process,"versions",' +
    '{value:{...process.versions,node:"22.12.0"}})';
  const run = runNexus(home, ['help'], { node: ['--import', older] });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'nexus: error: Nexus needs Node 24 or newer; this is Node 22.12.0.\n');
});

// Each ticket of the port takes its command out of this list as it lands.
test('a command not yet in the Node CLI says so and exits 1', () => {
  const home = newHome('not-ported');
  const commands: readonly (readonly string[])[] = [
    ['bootstrap'],
    ['setup'],
    ['link'],
    ['install'],
    ['update'],
    ['remove'],
    ['new'],
    ['check'],
    ['global'],
  ];
  for (const args of commands) {
    const run = runNexus(home, args);
    assert.equal(run.status, 1, args[0]);
    assert.equal(run.stdout, '', args[0]);
    assert.equal(
      run.stderr,
      `nexus: error: ${args[0]} is not in the Node CLI yet; run scripts/nexus ${args[0]}.\n`,
    );
  }
});
