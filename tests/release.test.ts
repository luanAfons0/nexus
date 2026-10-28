/**
 * The Plugin Release: what `npm run release` writes into `release/`, and that
 * it runs as the Host runs it (FirstMate ADR-0033 and ADR-0028).
 *
 * The suite builds one Plugin Release into the temporary root, with the
 * script the release workflow runs, and lands a copy of it as the Nexus home
 * of a test home: an installed Plugin Release is the Plugin directory and the
 * Nexus home at once, so its Control Skills are the ones it shipped. Each
 * answer is compared with what the repository's own `mcp.ts` and
 * `src/nexus.js` say, because a Plugin Release is the same Nexus, bundled.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { customHome, writeLock, writeSkill } from './helpers/homes.ts';
import { assertLinkTo } from './helpers/links.ts';
import { REPO_ROOT, runNexus, testRoot } from './helpers/nexus.ts';
import { envelopeOf, type Server, startServer } from './helpers/plugin-server.ts';

const WINDOWS = process.platform === 'win32';

/** Where the suite builds its one Plugin Release. */
const RELEASE = join(testRoot(), 'release');

before(() => {
  const run = spawnSync(process.execPath, [join('scripts', 'build-release.ts'), RELEASE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (run.error !== undefined) throw run.error;
  assert.equal(run.status, 0, run.stderr);
});

/** A test home whose Nexus home is a copy of the Plugin Release. */
function releaseHome(name: string): string {
  const home = customHome(name);
  const nexusHome = join(home, '.nexus');
  rmSync(nexusHome, { recursive: true });
  cpSync(RELEASE, nexusHome, { recursive: true });
  return home;
}

/** Every file under `root`, by its path from `root` with `/`, sorted. */
function filesUnder(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll('\\', '/'))
    .sort();
}

/** Start a server for a test, and stop it when the test ends. */
function serve(
  t: { after(fn: () => unknown): void },
  home: string,
  server: 'mcp.ts' | 'mcp.js',
): Server {
  const plugin = server === 'mcp.js' ? { directory: join(home, '.nexus'), server } : undefined;
  const started = startServer(home, plugin === undefined ? {} : { plugin });
  t.after(() => started.close());
  return started;
}

test('the Plugin Release holds no TypeScript, so the Host starts mcp.js', () => {
  const files = filesUnder(RELEASE);

  assert.ok(files.includes('mcp.js'), `no mcp.js in ${files.join(', ')}`);
  assert.deepEqual(
    files.filter((file) => file.endsWith('.ts')),
    [],
    'the Host starts mcp.ts before mcp.js',
  );
});

test('mcp.js answers initialize and tools/list the same as mcp.ts', async (t) => {
  const home = releaseHome('release-handshake');
  const source = serve(t, home, 'mcp.ts');
  const release = serve(t, home, 'mcp.js');

  for (const [method, params] of [
    ['initialize', { protocolVersion: '2025-06-18' }],
    ['tools/list', {}],
  ] as const) {
    assert.deepEqual(await release.ask(method, params), await source.ask(method, params), method);
  }
  assert.equal(release.stderr(), 'nexus: the Plugin Server is up\n');
});

test('a tool call of mcp.js runs the bundled CLI, which answers as the source does', async (t) => {
  const home = releaseHome('release-list');
  writeSkill(join(home, '.agents', 'skills'), 'alpha');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['alpha']);
  writeSkill(join(home, '.custom-skills'), 'mine');
  const release = serve(t, home, 'mcp.js');

  const envelope = envelopeOf(await release.call('list_skills'));

  const cli = runNexus(home, ['list', '--json']);
  assert.equal(envelope.exit, 0, envelope.stderr);
  assert.deepEqual(envelope, {
    command: ['nexus', 'list', '--json'],
    exit: cli.status,
    stdout: cli.stdout,
    stderr: cli.stderr,
    json: JSON.parse(cli.stdout),
  });
});

test('the Plugin Release holds what the Plugin reads at run time, and nothing else', () => {
  const files = filesUnder(RELEASE);
  const shipped = (folder: string) =>
    filesUnder(join(REPO_ROOT, folder)).map((file) => `${folder}/${file}`);

  // The Plugin Page and the Control Skills ship as they are, byte for byte:
  // the Host serves web/, and an installed Nexus is the Owner of skills/.
  for (const file of [...shipped('web'), ...shipped('skills')]) {
    assert.ok(
      readFileSync(join(RELEASE, file)).equals(readFileSync(join(REPO_ROOT, file))),
      `${file} did not ship as it is`,
    );
  }
  const bundled = files.filter((file) => file.startsWith('src/'));
  assert.ok(bundled.includes('src/nexus.js'), 'the CLI entry every Control Skill names');
  assert.deepEqual(
    bundled.filter((file) => !/^src\/[^/]+\.js$/.test(file)),
    [],
    'src/ holds the bundled CLI alone',
  );
  assert.deepEqual(
    files.filter((file) => !file.startsWith('src/')),
    ['mcp', 'mcp.js', 'package.json', ...shipped('skills'), ...shipped('web')].sort(),
  );
});

test('the Plugin Release holds no file Nexus keeps its data in', () => {
  const names = filesUnder(RELEASE).map((file) => file.split('/').pop());
  for (const data of ['skill-lock.json', 'skill-check.json', 'managed-copies.json']) {
    assert.ok(!names.includes(data), `${data} is data, and update would refuse on it`);
  }
});

test('the bundled CLI links the Control Skills the Plugin Release shipped', () => {
  const home = releaseHome('release-bootstrap');
  const cli = join(home, '.nexus', 'src', 'nexus.js');

  const run = runNexus(home, ['bootstrap'], { cli });

  assert.equal(run.status, 0, run.stderr);
  for (const root of ['.claude', '.codex']) {
    const link = join(home, root, 'skills', 'nexus-link');
    assertLinkTo(link, join(home, '.nexus', 'skills', 'nexus-link'));
  }
});

test(
  'the sh launcher of the Plugin Release starts mcp.js',
  { skip: WINDOWS && 'a wsl Place alone starts ./mcp' },
  async () => {
    const home = releaseHome('release-launcher');
    const plugin = { directory: join(home, '.nexus'), server: 'mcp.js' } as const;

    const server = startServer(home, { launcher: true, plugin });
    const listed = envelopeOf(await server.call('list_skills'));
    assert.equal(await server.close(), 0);

    assert.equal(listed.exit, 0, listed.stderr);
    assert.equal(server.stderr(), 'nexus: the Plugin Server is up\n');
  },
);
