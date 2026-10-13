/**
 * The Plugin Server, `mcp.ts`: the tools the Plugin Page and the Tool Bus
 * call, each one subprocess run of the Nexus CLI, over stdio (Seam 2).
 *
 * These carry over the three Plugin Server cases of the Bash suite
 * and widen them to every tool, the refusals of the protocol, one mutation at
 * a time, and the timeout. Each Envelope is compared with what the CLI says
 * for the same home, because the page shows exactly what the command line
 * shows (ADR 0008). No case reaches the network: `gh` and `npx` are fakes.
 *
 * Every case runs on Linux and on Windows, but the `sh` launcher's, which is
 * there only for a `wsl` Place.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { customHome, writeLock, writeSkill } from './helpers/homes.ts';
import { installFake, runNexus } from './helpers/nexus.ts';
import {
  envelopeOf,
  LAUNCHER,
  type Reply,
  type Server,
  startServer,
  textOf,
} from './helpers/plugin-server.ts';

const WINDOWS = process.platform === 'win32';

/** Every tool, exactly as the Python `mcp` offered it. */
const TOOLS = [
  {
    name: 'list_skills',
    description: 'Every Skill of all three kinds: installed, custom and control.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'check_skills',
    description:
      'Ask GitHub which Installed Skills are Behind. Every Skill comes back as current, ' +
      'behind or unknown, with the moment the check ran. It applies nothing.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'show_check_result',
    description:
      'The last Check Result: what every Installed Skill was at the moment one Check ran. ' +
      'It asks GitHub nothing and applies nothing.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'show_global_instructions',
    description:
      'The Global Instructions: their owner, whether the file is there, its sha256, ' +
      'and its content.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_skill',
    description: 'Update one Installed Skill from its upstream source, then link.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The Skill Name.' } },
      required: ['name'],
    },
  },
  {
    name: 'remove_skill',
    description: 'Remove one Installed Skill from the Nexus Lock, then link.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The Skill Name.' } },
      required: ['name'],
    },
  },
  {
    name: 'edit_global_instructions',
    description:
      'Replace the Global Instructions whole. `ifMatch` is the sha256 the editor started ' +
      'from, so a change made elsewhere is refused rather than overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The whole new file.' },
        ifMatch: { type: 'string', description: 'The sha256 this edit started from.' },
      },
      required: ['content', 'ifMatch'],
    },
  },
];

/** One skill of the check lock, from GitHub. */
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
 * The lock of `check_write_lock`: two Installed Skills Behind, one current,
 * and one in a repository the fake `gh` cannot reach.
 */
const FOUR_SKILLS = {
  'behind-skill': skill('owner/moved', 'skills/behind-skill/SKILL.md', 'aaaa'),
  'current-skill': skill('owner/quiet', 'skills/current-skill/SKILL.md', 'bbbb'),
  'unreachable-skill': skill('owner/gone', 'skills/unreachable-skill/SKILL.md', 'cccc'),
  'whole-repository-skill': skill('owner/moved', 'SKILL.md', 'dddd'),
};

/** A home with the four-skill lock and the fake `gh` first on PATH. */
function checkHome(name: string): string {
  const home = customHome(name);
  installFake(home, 'gh', 'gh-check.ts');
  const lock = { version: 3, skills: FOUR_SKILLS };
  writeFileSync(join(home, '.nexus', 'skill-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  return home;
}

/** A home with `alpha` installed in both locks and a fake `npx` first on PATH. */
function skillHome(name: string, behaviour: string): string {
  const home = customHome(name);
  installFake(home, 'npx', behaviour);
  writeSkill(join(home, '.agents', 'skills'), 'alpha');
  writeLock(join(home, '.agents', '.skill-lock.json'), ['alpha']);
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['alpha']);
  return home;
}

/** A PATH that holds the home's fake programs and nothing else: no `gh`, no `node`. */
const ONLY_FAKES = { PATH: '' };

/** The path of `GLOBAL.md` in a home. */
function globalFile(home: string): string {
  return join(home, '.custom-skills', 'GLOBAL.md');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The Envelope a run of the CLI gives, as the server builds it. */
function cliEnvelope(home: string, args: readonly string[], env = {}, input?: string) {
  const run = runNexus(home, args, { env, input });
  const envelope = {
    command: ['nexus', ...args],
    exit: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
  };
  return run.status === 0 ? withJson(envelope) : envelope;
}

function withJson<T extends { readonly stdout: string }>(envelope: T): T & { json?: unknown } {
  try {
    return { ...envelope, json: JSON.parse(envelope.stdout) as unknown };
  } catch {
    return envelope;
  }
}

/** Start a server for one case, and close it when the case ends. */
function serve(t: { after(fn: () => unknown): void }, home: string, env = {}): Server {
  const server = startServer(home, { env });
  t.after(() => server.close());
  return server;
}

/** Wait until `ready` is true, or fail after `ms`. */
async function until(ready: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`gave up waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Every process ID the hang fake wrote in a home. */
function hungPids(home: string): readonly number[] {
  const file = join(home, 'hung.pids');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map(Number);
}

/**
 * A home whose `npx` never ends. Whatever the case proves, no hung fake
 * outlives it.
 */
function hangHome(t: { after(fn: () => unknown): void }, name: string): string {
  const home = skillHome(name, 'hang.ts');
  t.after(() => {
    for (const pid of hungPids(home)) if (alive(pid)) process.kill(pid);
  });
  return home;
}

/** Whether a process runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (fault) {
    return (fault as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lines of a stream that Nexus wrote. */
function nexusLines(text: string): readonly string[] {
  return text.split('\n').filter((line) => line.startsWith('nexus:'));
}

function errorOf(reply: Reply): { readonly code: number; readonly message: string } {
  const shown = JSON.stringify(reply);
  assert.equal(reply.result, undefined, `a refusal came back as a result: ${shown}`);
  assert.ok(reply.error, `the reply carries no error: ${JSON.stringify(reply)}`);
  return reply.error;
}

test('the Plugin Server says it is up, and answers initialize and ping', async (t) => {
  const server = serve(t, customHome('server-handshake'));

  const hello = await server.ask('initialize', { protocolVersion: '2025-06-18' });
  assert.deepEqual(hello, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'nexus', version: '1.0.0' },
    },
  });
  assert.deepEqual(await server.ask('ping'), { jsonrpc: '2.0', id: 2, result: {} });
  assert.equal(server.stderr(), 'nexus: the Plugin Server is up\n');
});

test('tools/list offers every tool with the same description and input schema', async (t) => {
  const server = serve(t, customHome('server-tools'));

  const reply = await server.ask('tools/list', {});

  assert.deepEqual(reply.result, { tools: TOOLS });
});

test('list_skills answers the Envelope of nexus list --json', async (t) => {
  const home = customHome('server-list');
  writeSkill(join(home, '.agents', 'skills'), 'alpha');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['alpha']);
  writeSkill(join(home, '.custom-skills'), 'mine');
  const server = serve(t, home);

  const reply = await server.call('list_skills');

  const envelope = envelopeOf(reply);
  assert.deepEqual(envelope, cliEnvelope(home, ['list', '--json']));
  assert.equal(envelope.exit, 0);
  assert.deepEqual(Object.keys(envelope), ['command', 'exit', 'stdout', 'stderr', 'json']);
  assert.deepEqual(JSON.parse(textOf(reply)), envelope, 'the text half is not the Envelope');
  assert.equal(reply.result?.['isError'], undefined);
});

test('a CLI child runs on the Node of the server, with no node on PATH', async (t) => {
  const home = customHome('server-own-node');
  const server = serve(t, home, ONLY_FAKES);

  const envelope = envelopeOf(await server.call('list_skills'));

  assert.equal(envelope.exit, 0, envelope.stderr);
  assert.deepEqual(envelope.command, ['nexus', 'list', '--json']);
});

test('check_skills answers one sentence of counts and the whole Envelope', async (t) => {
  const home = checkHome('server-check');
  const server = serve(t, home);

  const reply = await server.call('check_skills');

  const envelope = envelopeOf(reply);
  assert.equal(envelope.exit, 0, envelope.stderr);
  assert.deepEqual(envelope.command, ['nexus', 'check', '--json']);
  const json = envelope.json as {
    checkedAt: string;
    counts: Record<string, number>;
    skills: unknown[];
  };
  assert.deepEqual(json.counts, { current: 1, behind: 2, unknown: 1 });
  assert.equal(json.skills.length, 4);
  assert.deepEqual(Object.keys(envelope), ['command', 'exit', 'stdout', 'stderr', 'json']);
  assert.equal(
    textOf(reply),
    `4 Installed Skills: 1 current, 2 Behind, 1 unknown. Checked ${json.checkedAt}.`,
  );
});

test('a check of one Installed Skill says it in the singular', async (t) => {
  const home = checkHome('server-check-one');
  const lock = { version: 3, skills: { 'current-skill': FOUR_SKILLS['current-skill'] } };
  writeFileSync(join(home, '.nexus', 'skill-lock.json'), `${JSON.stringify(lock)}\n`);
  const server = serve(t, home);

  const reply = await server.call('check_skills');

  const checkedAt = (envelopeOf(reply).json as { checkedAt: string }).checkedAt;
  assert.equal(
    textOf(reply),
    `1 Installed Skill: 1 current, 0 Behind, 0 unknown. Checked ${checkedAt}.`,
  );
});

test('a failed check is a JSON-RPC error carrying the last sentence the CLI said', async (t) => {
  const loggedOut = serve(t, checkHome('server-check-logged-out'), {
    NEXUS_FAKE_GH_MODE: 'logged_out',
  });
  const refused = await loggedOut.call('check_skills');
  assert.deepEqual(errorOf(refused), {
    code: -32603,
    message: 'nexus: error: the GitHub CLI is not logged in: run gh auth login',
  });

  const noGh = customHome('server-check-no-gh');
  const lock = { version: 3, skills: FOUR_SKILLS };
  writeFileSync(join(noGh, '.nexus', 'skill-lock.json'), `${JSON.stringify(lock)}\n`);
  const missing = serve(t, noGh, ONLY_FAKES);
  assert.deepEqual(errorOf(await missing.call('check_skills')), {
    code: -32603,
    message: 'nexus: error: the GitHub CLI is not available: install gh, then run gh auth login',
  });
});

test('show_check_result reads the last check, and its refusal stays an Envelope', async (t) => {
  const home = checkHome('server-check-result');
  const server = serve(t, home, ONLY_FAKES);

  const none = await server.call('show_check_result');
  const refusal = envelopeOf(none);
  assert.deepEqual(refusal, cliEnvelope(home, ['check', '--last', '--json'], ONLY_FAKES));
  assert.equal(refusal.exit, 1);
  assert.match(refusal.stderr, /no check has run yet/);
  assert.equal(JSON.parse(textOf(none)).exit, 1, 'this tool stopped answering with its Envelope');

  assert.equal(runNexus(home, ['check']).status, 0);
  const last = envelopeOf(await server.call('show_check_result'));
  assert.equal(last.exit, 0, last.stderr);
  const json = last.json as { checkedAt: unknown; counts: unknown };
  assert.deepEqual(json.counts, { current: 1, behind: 2, unknown: 1 });
  assert.equal(typeof json.checkedAt, 'string');
});

test('show_global_instructions answers the Envelope of nexus global show --json', async (t) => {
  const home = customHome('server-global-show');
  writeFileSync(globalFile(home), '# Global\n\nBe brief.\n');
  const server = serve(t, home);

  const envelope = envelopeOf(await server.call('show_global_instructions'));

  assert.deepEqual(envelope, cliEnvelope(home, ['global', 'show', '--json']));
  assert.equal((envelope.json as { content: unknown }).content, '# Global\n\nBe brief.\n');
});

test('update_skill runs nexus update for the one name it is given', async (t) => {
  const home = skillHome('server-update', 'npx-update.ts');
  const twin = skillHome('server-update-twin', 'npx-update.ts');
  const server = serve(t, home);

  const envelope = envelopeOf(await server.call('update_skill', { name: 'alpha' }));

  assert.equal(envelope.exit, 0, envelope.stderr);
  assert.deepEqual(envelope.command, ['nexus', 'update', 'alpha']);
  const cli = cliEnvelope(twin, ['update', 'alpha']);
  assert.equal(envelope.stdout.replaceAll(home, '<home>'), cli.stdout.replaceAll(twin, '<home>'));
  // Only what Nexus said: a test run from a UNC path on Windows gets cmd.exe's
  // own complaint about it from `npx.cmd`, which no installed Nexus sees.
  assert.deepEqual(nexusLines(envelope.stderr), nexusLines(cli.stderr));
  assert.match(envelope.stdout, /updated alpha: hash test-hash -> hash-new/);
});

test('a CLI refusal is an ordinary result carrying its exit code', async (t) => {
  const home = skillHome('server-refusal', 'npx-update.ts');
  const server = serve(t, home);

  const reply = await server.call('update_skill', { name: 'nobody' });
  const unsafe = envelopeOf(await server.call('remove_skill', { name: '../alpha' }));

  const envelope = envelopeOf(reply);
  assert.deepEqual(envelope, cliEnvelope(home, ['update', 'nobody']));
  assert.equal(envelope.exit, 1);
  assert.equal(reply.result?.['isError'], undefined);
  assert.equal(JSON.parse(textOf(reply)).exit, 1);
  assert.deepEqual(unsafe, cliEnvelope(home, ['remove', '../alpha']));
  assert.equal(unsafe.exit, 2);
});

test('remove_skill runs nexus remove for the one name it is given', async (t) => {
  const home = skillHome('server-remove', 'npx-remove.ts');
  const server = serve(t, home);

  const envelope = envelopeOf(await server.call('remove_skill', { name: 'alpha' }));

  assert.equal(envelope.exit, 0, envelope.stderr);
  assert.deepEqual(envelope.command, ['nexus', 'remove', 'alpha']);
  assert.match(envelope.stdout, /alpha/);
  const lock = JSON.parse(readFileSync(join(home, '.nexus', 'skill-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock.skills), []);
});

test('edit_global_instructions hands the content to nexus global edit on stdin', async (t) => {
  const home = customHome('server-global-edit');
  writeFileSync(globalFile(home), 'old\n');
  const server = serve(t, home);
  const content = 'new — with "quotes", $HOME and a newline\n';

  const envelope = envelopeOf(
    await server.call('edit_global_instructions', { content, ifMatch: sha256('old\n') }),
  );

  assert.equal(envelope.exit, 0, envelope.stderr);
  assert.deepEqual(envelope.command, ['nexus', 'global', 'edit', '--if-match', sha256('old\n')]);
  assert.equal(readFileSync(globalFile(home), 'utf8'), content);

  // A change made elsewhere is refused, and the refusal is an Envelope.
  const stale = envelopeOf(
    await server.call('edit_global_instructions', { content: 'lost\n', ifMatch: sha256('old\n') }),
  );
  assert.equal(stale.exit, 1);
  assert.deepEqual(
    stale,
    cliEnvelope(home, ['global', 'edit', '--if-match', sha256('old\n')], {}, 'lost\n'),
  );
  assert.equal(readFileSync(globalFile(home), 'utf8'), content);
});

test('a call the server will not run is a JSON-RPC error naming what is wrong', async (t) => {
  const server = serve(t, customHome('server-refusals'));

  const cases: readonly [Promise<Reply>, number, string][] = [
    [server.call('polish_boots'), -32602, 'no such tool: polish_boots'],
    [server.ask('tools/call', { arguments: {} }), -32602, 'no such tool: None'],
    [server.call('update_skill', {}), -32602, 'update_skill needs name as a string'],
    [server.call('remove_skill', { name: 7 }), -32602, 'remove_skill needs name as a string'],
    [
      server.call('edit_global_instructions', { content: 'x' }),
      -32602,
      'edit_global_instructions needs ifMatch as a string',
    ],
    [server.call('list_skills', ['a']), -32602, 'arguments must be an object'],
    [server.call('list_skills', 'a'), -32602, 'arguments must be an object'],
    [server.ask('tools/nonsense'), -32601, 'no such method: tools/nonsense'],
  ];
  for (const [reply, code, message] of cases) {
    assert.deepEqual(errorOf(await reply), { code, message });
  }
});

test('a notification is not answered, and a line that is not JSON is one sentence', async (t) => {
  const server = serve(t, customHome('server-lines'));

  server.send('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  server.send('{"jsonrpc":"2.0","id":null,"method":"ping"}');
  server.send('this is not JSON');
  server.send('');
  const reply = await server.ask('ping');

  assert.deepEqual(reply, { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(server.lines().length, 1, 'something but the ping was answered');
  assert.equal(
    server.stderr(),
    'nexus: the Plugin Server is up\nnexus: a line on stdin was not JSON\n',
  );
});

test('a second mutation is BUSY, and a read during a mutation is answered', async (t) => {
  const home = hangHome(t, 'server-busy');
  writeFileSync(globalFile(home), 'old\n');
  const server = serve(t, home, { NEXUS_MCP_TIMEOUT: '20' });

  const first = server.call('update_skill', { name: 'alpha' });
  await until(() => hungPids(home).length === 1, 'the update to start npx');

  const busy = { code: -32000, message: 'another change is already running' };
  assert.deepEqual(errorOf(await server.call('remove_skill', { name: 'alpha' })), busy);
  assert.deepEqual(
    errorOf(await server.call('edit_global_instructions', { content: 'x', ifMatch: 'y' })),
    busy,
  );
  // A bad call is refused for what it is, before the lock is asked.
  assert.equal(errorOf(await server.call('remove_skill', {})).code, -32602);
  const read = envelopeOf(await server.call('list_skills'));
  assert.equal(read.exit, 0, read.stderr);
  assert.ok(hungPids(home).every(alive), 'the read waited for the mutation');

  // End the hung npx, so the first call ends and the next mutation runs.
  for (const pid of hungPids(home)) process.kill(pid);
  const ended = envelopeOf(await first);
  assert.notEqual(ended.exit, 0);
  const next = envelopeOf(
    await server.call('edit_global_instructions', { content: 'new\n', ifMatch: sha256('old\n') }),
  );
  assert.equal(next.exit, 0, next.stderr);
});

test('a CLI child past the timeout is ended with every program it started', async (t) => {
  const home = hangHome(t, 'server-timeout');
  const server = serve(t, home, { NEXUS_MCP_TIMEOUT: '1' });

  const envelope = envelopeOf(await server.call('update_skill', { name: 'alpha' }));

  assert.equal(envelope.exit, 124);
  assert.ok(
    envelope.stderr.endsWith('nexus: command killed after 1.0 seconds (timeout)\n'),
    envelope.stderr,
  );
  assert.equal(envelope.json, undefined);
  const pids = hungPids(home);
  assert.equal(pids.length, 1);
  await until(() => !pids.some(alive), `the hung npx ${pids.join(' ')} to end`, 10_000);

  // The lock is free again.
  const next = envelopeOf(await server.call('remove_skill', { name: '../x' }));
  assert.equal(next.exit, 2);
});

test('the timeout sentence says the seconds as the Python server did', async (t) => {
  const home = hangHome(t, 'server-timeout-half');
  const server = serve(t, home, { NEXUS_MCP_TIMEOUT: '0.5' });

  const envelope = envelopeOf(await server.call('update_skill', { name: 'alpha' }));

  assert.equal(envelope.exit, 124);
  assert.ok(
    envelope.stderr.endsWith('nexus: command killed after 0.5 seconds (timeout)\n'),
    envelope.stderr,
  );
});

test('a timeout that is no number stops the server with one sentence', async () => {
  const server = startServer(customHome('server-bad-timeout'), {
    env: { NEXUS_MCP_TIMEOUT: 'soon' },
  });

  const status = await server.close();

  assert.equal(status, 1);
  assert.equal(server.stderr(), 'nexus: NEXUS_MCP_TIMEOUT must be a number of seconds: soon\n');
});

test('closing stdin ends the server once every call in flight is answered', async () => {
  const home = skillHome('server-close', 'npx-update.ts');
  const server = startServer(home);

  const reply = server.call('update_skill', { name: 'alpha' });
  const status = await server.close();

  assert.equal(status, 0);
  assert.equal(envelopeOf(await reply).exit, 0);
});

test(
  'the sh launcher starts the Plugin Server from ./mcp',
  { skip: WINDOWS && 'a wsl Place alone starts ./mcp' },
  async () => {
    const lines = readFileSync(LAUNCHER, 'utf8').split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 2, 'the launcher holds logic');
    assert.equal(lines[0], '#!/bin/sh');
    assert.ok((statSync(LAUNCHER).mode & 0o111) !== 0, 'the launcher is not executable');

    const server = startServer(customHome('server-launcher'), { launcher: true });
    const reply = await server.ask('initialize', {});
    const listed = envelopeOf(await server.call('list_skills'));
    assert.equal(await server.close(), 0);

    assert.equal((reply.result?.['serverInfo'] as { name: string }).name, 'nexus');
    assert.equal(listed.exit, 0, listed.stderr);
    assert.equal(server.stderr(), 'nexus: the Plugin Server is up\n');
  },
);
