/**
 * The documents that ship with the code: the Control Skills, the README, the
 * decision records and the Ubiquitous Language, and the shape of the tree.
 *
 * An agent runs a Control Skill word for word, and a person installs Nexus
 * from the README alone, so a stale command in either is a broken feature.
 * These cases read the files as a person or an agent reads them. The Control
 * Skills and the README name one CLI form, which works in bash, zsh and
 * PowerShell alike: `node "$HOME/.nexus/src/nexus.js" <command>`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT, testRoot } from './helpers/nexus.ts';

/** The CLI form every Control Skill and the README name. */
const CLI_FORM = 'node "$HOME/.nexus/src/nexus.js"';

/** Each Control Skill and the text it must hold to run its command. */
const CONTROL_SKILLS: Readonly<Record<string, readonly string[]>> = {
  'nexus-setup': [`${CLI_FORM} setup`],
  'nexus-link': [`${CLI_FORM} link`],
  'nexus-install': [`${CLI_FORM} install`, '--skill "skill-a" --skill "skill-b"'],
  'nexus-new': [`${CLI_FORM} new`, `${CLI_FORM} link`],
  'nexus-help': [`${CLI_FORM} list`, `${CLI_FORM} help`],
  'nexus-update': [`${CLI_FORM} update`],
  'nexus-remove': [`${CLI_FORM} remove`],
  nexus: ['FIRSTMATE_HOME', '/p/nexus/', 'runtime.json'],
};

/** What no document a person or an agent follows may name: it is gone. */
const GONE = [
  'scripts/nexus',
  'python3',
  '`jq`',
  'bash tests/run.sh',
  'systemctl --user start',
  'journalctl',
];

/** The text of a file in the repository. */
function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

/** Assert that `path` holds each of `terms`, naming every one it lacks. */
function assertHolds(path: string, terms: readonly string[]): void {
  const text = read(path);
  const missing = terms.filter((term) => !text.includes(term));
  assert.deepEqual(missing, [], `${path} lacks these terms`);
}

/** Assert that `path` holds none of `terms`, naming every one it holds. */
function assertLacks(path: string, terms: readonly string[]): void {
  const text = read(path);
  const present = terms.filter((term) => text.includes(term));
  assert.deepEqual(present, [], `${path} still holds these terms`);
}

/** Every file Git tracks, by its path in the repository. */
function trackedFiles(): readonly string[] {
  const run = spawnSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (run.error !== undefined) throw run.error;
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split('\0').filter((path) => path !== '' && existsSync(join(REPO_ROOT, path)));
}

test('every Control Skill names itself and runs its command in the one CLI form', () => {
  assert.ok(existsSync(join(REPO_ROOT, 'src', 'nexus.js')), 'the CLI entry the form names');
  for (const [name, terms] of Object.entries(CONTROL_SKILLS)) {
    const path = `skills/${name}/SKILL.md`;
    assert.ok(read(path).split('\n').includes(`name: ${name}`), `${path} names itself`);
    assert.ok(!existsSync(join(REPO_ROOT, 'skills', name, 'claude-command.md')), name);
    assertHolds(path, terms);
    assertLacks(path, GONE);
  }
  assertLacks('skills/nexus-install/SKILL.md', ['install "/path/to/source" "skill-a"']);
});

test('the nexus launcher prints the page address and owns no run', () => {
  assertLacks('skills/nexus/SKILL.md', ['nohup', 'disown', 'mktemp', 'sleep', 'nexus ui', 'Stop server']);
});

test('the nexus launcher command prints the page address from the FirstMate runtime file', () => {
  const line = read('skills/nexus/SKILL.md')
    .split('\n')
    .find((each) => each.startsWith('node -e "'));
  assert.ok(line !== undefined, 'the launcher has one node -e line');
  const code = line.slice('node -e "'.length, -1);
  const firstmate = join(testRoot(), 'firstmate-home');
  mkdirSync(firstmate, { recursive: true });
  writeFileSync(join(firstmate, 'runtime.json'), '{"port":4848,"token":"t0ken"}\n');
  const run = spawnSync(process.execPath, ['-e', code], {
    env: { ...process.env, FIRSTMATE_HOME: firstmate },
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'http://127.0.0.1:4848/p/nexus/?token=t0ken\n');
});

test('the README says how to install, run and recover Nexus on Node alone', () => {
  assertHolds('README.md', [
    '~/.agents/skills', 'skill-lock.json', '.claude-backup', '.codex-backup',
    '/nexus-setup', '$nexus-setup', 'npx skills', 'recovery', 'another agent',
    '~/.custom-skills', '/nexus-new', '$nexus-new', '.workspaces',
    '/nexus-update', '$nexus-update', '/nexus-remove', '$nexus-remove',
    '/nexus-help', '$nexus-help', 'nexus list', '`/nexus`', '`$nexus`', 'Save changes',
    '## Global instructions', '~/.custom-skills/GLOBAL.md',
    '0003-global-instructions-are-a-managed-link-into-the-custom-root.md',
    '0004-nexus-writes-only-global-md-in-the-custom-root.md',
    '## The page', '0008-nexus-is-a-firstmate-plugin.md',
    '0005-nexus-opens-one-loopback-listener-only-in-nexus-ui.md',
    '0006-a-web-ui-run-is-recorded-in-a-run-file-and-can-be-stopped.md',
    '0007-the-tray-is-a-windows-client-of-the-nexus-cli.md',
    '0010-on-windows-a-managed-link-is-a-junction-or-a-managed-copy.md',
    '#/skills', '#/global', '/p/nexus/', 'Plugin Server', 'Plugin Page',
    'list_skills', 'check_skills', 'show_check_result', 'show_global_instructions',
    'update_skill', 'remove_skill', 'edit_global_instructions', 'Connection lost.',
    'grouped by kind', 'All kinds',
    'Node 24', 'npx.cmd', 'junction', 'Managed Copy', CLI_FORM,
    'node scripts/dev-home.ts', 'node --test',
    'it does not check Git, npm, npx, or NVM',
    'directly available `npx`; if it is unavailable, NVM is the fallback',
    'retries once and then removes the temporary transaction, leaves',
  ]);
  // The listener, the Run File and the Tray left with ADR 0008, and the Bash
  // CLI, Python and jq left with the port to Node.
  assertLacks('README.md', [...GONE, 'nexus ui', 'http.server', 'ui-run.json', 'POST api/', 'GET api/']);
});

test('the contributor documents name the Node suite and the sandbox home command', () => {
  for (const path of ['AGENTS.md', 'CONTRIBUTING.md', '.github/pull_request_template.md']) {
    assertHolds(path, ['npm run check', 'node scripts/dev-home.ts']);
    assertLacks(path, [...GONE, 'tests/cases/', 'faults.sh', 'scripts/dev-home`']);
  }
});

test('the decision records and the Ubiquitous Language ship with the code', () => {
  // The three superseded records stay in the tree: they are why Nexus once
  // owned a listener, a Run File and a Tray.
  const superseded = [
    '0005-nexus-opens-one-loopback-listener-only-in-nexus-ui',
    '0006-a-web-ui-run-is-recorded-in-a-run-file-and-can-be-stopped',
    '0007-the-tray-is-a-windows-client-of-the-nexus-cli',
  ];
  for (const adr of superseded) assertHolds(`docs/adr/${adr}.md`, ['Superseded by ADR 0008']);
  assertHolds('docs/adr/0008-nexus-is-a-firstmate-plugin.md', ['Accepted']);
  assertHolds('CONTEXT.md', [
    '**Host**', '**Plugin**', '**Plugin Page**', '**Plugin Server**', '**Envelope**',
    '**Managed Link**', '**Managed Copy**',
  ]);
});

test('Git ignores the Nexus Lock, the Check Result and the Managed Copy record', () => {
  for (const name of ['skill-lock.json', 'skill-check.json', 'managed-copies.json']) {
    const run = spawnSync('git', ['check-ignore', '-q', '--', name], { cwd: REPO_ROOT, shell: false });
    assert.equal(run.status, 0, `${name} is not ignored`);
  }
});

test('Nexus runs on Node alone: no Bash, Python or jq file, and no runtime dependency', () => {
  const foreign = trackedFiles().filter((path) => {
    if (path === 'mcp') return false;
    if (/\.(sh|bash|py)$/.test(path)) return true;
    const first = readFileSync(join(REPO_ROOT, path)).subarray(0, 64).toString('latin1');
    return /^#!.*\b(sh|bash|python3?|jq)\b/.test(first);
  });
  assert.deepEqual(foreign, []);

  // The one file that is not Node: the launcher a FirstMate `wsl` Place starts.
  assert.equal(read('mcp'), '#!/bin/sh\nexec node "$(dirname -- "$0")/mcp.ts" "$@"\n');

  const manifest = JSON.parse(read('package.json')) as Record<string, unknown>;
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.devDependencies as object).sort(), ['@types/node', 'typescript']);
});
