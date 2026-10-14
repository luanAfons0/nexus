/**
 * Seam 2: the Plugin Server over stdio, against a home of the test's own.
 *
 * A test starts `mcp.ts` as the FirstMate Host does (ADR-0028 of FirstMate):
 * `process.execPath` with the file's name, in the Plugin directory, with no
 * shell. It speaks JSON-RPC one message per line and reads the replies, the
 * Envelopes in them and the server's stderr. No test imports a module of the
 * server, so its inside can be rewritten without touching a test.
 *
 * The environment is the one `runNexus` gives the CLI: the home's fake
 * programs first on PATH, and HOME and the Nexus home moved into the test
 * home, so no case reaches a real Agent Context.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { homeEnvironment, REPO_ROOT } from './nexus.ts';

/** The Plugin Server file the Host starts with its own Node. */
export const SERVER = join(REPO_ROOT, 'mcp.ts');

/** The `sh` launcher a `wsl` Place starts as `./mcp`. */
export const LAUNCHER = join(REPO_ROOT, 'mcp');

/** One JSON-RPC reply, as the server wrote it. */
export type Reply = {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code: number; readonly message: string };
};

/** The Envelope every tool answers. */
export type Envelope = {
  readonly command: readonly string[];
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json?: unknown;
};

/** A running Plugin Server. */
export type Server = {
  /** Ask one request with a fresh id, and wait for its reply. */
  ask(method: string, params?: unknown): Promise<Reply>;
  /** Call one tool, and wait for its reply. */
  call(name: string, args?: unknown): Promise<Reply>;
  /** Write one raw line to stdin. */
  send(line: string): void;
  /** Every line the server wrote to stdout so far. */
  lines(): readonly string[];
  /** Everything the server wrote to stderr so far. */
  stderr(): string;
  /** Close stdin, as the Host does to stop it, and wait for it to end. */
  close(): Promise<number | null>;
};

/** How a server differs from a plain one. */
export type ServerOptions = {
  /** More environment variables. A `PATH` here replaces the inherited one. */
  readonly env?: Readonly<Record<string, string>>;
  /** Start the `sh` launcher `./mcp` rather than `mcp.ts`. */
  readonly launcher?: boolean;
};

/** Start the Plugin Server against a test home. */
export function startServer(home: string, options: ServerOptions = {}): Server {
  const env = homeEnvironment(home, options.env ?? {});
  const child: ChildProcessWithoutNullStreams = options.launcher
    ? spawn('./mcp', [], { cwd: REPO_ROOT, env, shell: false })
    : spawn(process.execPath, ['mcp.ts'], { cwd: REPO_ROOT, env, shell: false, windowsHide: true });
  const lines: string[] = [];
  const waiting = new Map<unknown, (reply: Reply) => void>();
  let stderr = '';
  let next = 0;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    const reply = JSON.parse(line) as Reply;
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  const ended = new Promise<number | null>((resolve) => child.on('close', resolve));

  const ask = (method: string, params?: unknown): Promise<Reply> => {
    next += 1;
    const id = next;
    const reply = new Promise<Reply>((resolve, reject) => {
      waiting.set(id, resolve);
      void ended.then(() => reject(new Error(`the Plugin Server ended before it answered ${id}`)));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return reply;
  };
  return {
    ask,
    call: (name, args = {}) => ask('tools/call', { name, arguments: args }),
    send: (line) => child.stdin.write(`${line}\n`),
    lines: () => lines,
    stderr: () => stderr,
    close: () => {
      child.stdin.end();
      return ended;
    },
  };
}

/** The Envelope of a reply, or a failure that shows the whole reply. */
export function envelopeOf(reply: Reply): Envelope {
  const structured = reply.result?.['structuredContent'];
  if (structured === undefined) {
    throw new Error(`the reply carries no Envelope: ${JSON.stringify(reply)}`);
  }
  return structured as Envelope;
}

/** The text half of a reply's result. */
export function textOf(reply: Reply): string {
  const content = reply.result?.['content'] as readonly { readonly text: string }[] | undefined;
  const text = content?.[0]?.text;
  if (text === undefined) throw new Error(`the reply carries no text: ${JSON.stringify(reply)}`);
  return text;
}
