/**
 * The CLI entry and its dispatch: help, the usage refusal, and the refusal of
 * a Node that is too old.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newHome, runNexus } from './helpers/nexus.ts';

const HELP = `Usage: nexus <bootstrap|setup|link|install|update|remove|new|list|check|global|help>
Run it as: node "$HOME/.nexus/src/nexus.js" <command>

bootstrap    Link only the Nexus control skills.
setup        Take the Backups, publish the first Nexus Lock, and link, once.
link         Make the Managed Links of Claude and Codex match the Nexus Lock.
install      Install selected skills from one source via upstream npx skills.
update       Update one installed skill and link.
remove       Uninstall one installed skill and link.
new          Reserve a custom skill directory.
list         Show installed, custom, and control skills: list [--json].
check        Ask GitHub which installed skills are behind: check [--json]; \
the last result: check --last [--json].
global       Show or replace the Global Instructions: global show [--json], \
global edit [--if-match <sha256>].
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

test(
  'a missing command, an unknown one, or an extra argument prints the usage on stderr and exits 2',
  () => {
    const home = newHome('usage');
    for (const args of USAGE_REFUSALS) {
      const run = runNexus(home, args);
      assert.equal(run.status, 2, JSON.stringify(args));
      assert.equal(run.stdout, '', JSON.stringify(args));
      assert.equal(run.stderr, HELP, JSON.stringify(args));
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
