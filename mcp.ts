/**
 * Nexus as a FirstMate Plugin Server: MCP over stdio, one JSON-RPC message
 * per line.
 *
 * The Host runs this file with its own Node, in the Nexus home, with no shell
 * (FirstMate ADR-0028), and hands its tools to the Plugin Page at one
 * address. In a `wsl` Place the Host starts `./mcp` instead, a two-line `sh`
 * launcher that hands this file to the `node` on PATH.
 *
 * Every tool is one subprocess run of the Nexus CLI (ADR 0008), started as
 * `process.execPath` with the CLI entry and no shell, so under the App it is
 * the App's Node with `ELECTRON_RUN_AS_NODE` inherited. This program never
 * reads or writes `GLOBAL.md`, the Nexus Lock or a skill root. Each answer is
 * the Envelope the page already knows, `{command, exit, stdout, stderr}` plus
 * `json` when stdout parses.
 *
 * A non-zero exit is not a tool error. `nexus remove` refusing a name is a
 * refusal the page must show, so it comes back as an ordinary result carrying
 * the Envelope, and the page reads the exit code as it always did.
 *
 * `check_skills` is the one tool that breaks that habit, on purpose
 * (ADR 0009). A caller on the Tool Bus has to decide an Outcome from its
 * answer, and cannot read an exit code out of a successful result. So a check
 * that failed is a JSON-RPC error carrying the sentence the CLI ended with,
 * and a check that worked carries one plain sentence of counts in the text
 * half of its result. The structured half of every result stays the Envelope.
 *
 * One mutation runs at a time; reads are never locked, so a slow update never
 * stops the page from listing skills. A CLI child that runs past
 * `NEXUS_MCP_TIMEOUT` seconds is ended with every program it started: its
 * process group on Linux, its whole tree on Windows.
 *
 * Nothing but replies goes to stdout. stderr carries two sentences only: the
 * banner when the server is up, and a line on stdin that was not JSON.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isObject } from './src/json.ts';

/** The Nexus home this file sits in. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The CLI entry each tool runs: `node <Nexus home>/src/nexus.js <command>`.
 * In a Plugin Release this file is `mcp.js` and the entry beside it is the
 * bundled CLI (ADR 0011), so a tool call starts JavaScript Node need not strip.
 */
const CLI = join(HERE, 'src', 'nexus.js');

/**
 * What `command` names as element 0 of every Envelope. The page shows it by
 * its base name, so the Last command panel reads `nexus update docx` on
 * every system. The real argv starts with the Node and the entry, which a
 * person never types.
 */
const SHOWN_CLI = 'nexus';

/** The MCP version the Host speaks. Fixed, not negotiated. */
const PROTOCOL_VERSION = '2025-06-18';

/** What this Plugin Server calls itself when the Host asks. */
const SERVER_INFO = { name: 'nexus', version: '1.0.0' };

/** JSON-RPC's code for a method this server does not have. */
const METHOD_NOT_FOUND = -32601;
/** JSON-RPC's code for a call this server will not take as it is. */
const INVALID_PARAMS = -32602;
/** JSON-RPC's code for a fault, and for a failed `check_skills` (ADR 0009). */
const INTERNAL_ERROR = -32603;
/**
 * The range JSON-RPC leaves to the application. One change at a time was the
 * Web UI server's 409; it keeps a code of its own so the page can tell "wait
 * for the other command" from "you asked for something that is not there".
 */
const BUSY = -32000;

/** The exit code an Envelope carries for a child stopped by the timeout. */
const TIMED_OUT = 124;

/** The timeout in seconds when `NEXUS_MCP_TIMEOUT` is unset. */
const DEFAULT_TIMEOUT = '300';

/**
 * How long a stopped child's output may stay open before it is dropped. A
 * program that left the process group could hold the pipe for ever.
 */
const DRAIN_MS = 2000;

/**
 * The longest delay `setTimeout` keeps, about 24.8 days; a longer one would
 * fire at once. A longer timeout waits this long instead.
 */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

const WINDOWS = process.platform === 'win32';

/** What one tool answers, whatever the exit code. */
type Envelope = {
  readonly command: readonly string[];
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json?: unknown;
};

/** A tool that reads: it takes no arguments and no lock. */
type ReadCall = {
  readonly mutates: false;
  readonly tail: readonly string[];
  /** A non-zero exit is a JSON-RPC error, for a caller that must judge it. */
  readonly failsLoudly: boolean;
  /** The sentence the text half carries, when the tool has one. */
  readonly says?: (envelope: Envelope) => string | undefined;
};

/** A tool that changes something: one at a time. */
type WriteCall = {
  readonly mutates: true;
  /** The CLI tail, from arguments already proved to be strings. */
  readonly tail: (args: Readonly<Record<string, string>>) => readonly string[];
  /** The argument written to the child's stdin, when there is one. */
  readonly stdin?: string;
};

/** One string argument, as `tools/list` describes it. */
type TextProperty = { readonly type: 'string'; readonly description: string };

/** One tool, as `tools/list` describes it and as a call runs it. */
type Tool = {
  readonly description: string;
  readonly properties: Readonly<Record<string, TextProperty>>;
  /** The argument names, in the order each is checked to be a string. */
  readonly required: readonly string[];
  readonly call: ReadCall | WriteCall;
};

/** A result to send back, or a refusal with its code. */
type Answer =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/** A string argument a tool takes, as its schema says it. */
function text(description: string): TextProperty {
  return { type: 'string', description };
}

/** A tool that reads, with the CLI tail it runs. */
function readTool(tail: readonly string[], options: Partial<ReadCall> = {}): ReadCall {
  return { mutates: false, tail, failsLoudly: options.failsLoudly ?? false, says: options.says };
}

/** Every tool, in the order `tools/list` offers them. */
const TOOLS: Readonly<Record<string, Tool>> = {
  list_skills: {
    description: 'Every Skill of all three kinds: installed, custom and control.',
    properties: {},
    required: [],
    call: readTool(['list', '--json']),
  },
  check_skills: {
    description:
      'Ask GitHub which Installed Skills are Behind. Every Skill comes back as current, ' +
      'behind or unknown, with the moment the check ran. It applies nothing.',
    properties: {},
    required: [],
    // A failed check is a tool error, not an Envelope: the Scheduler has to
    // decide an Outcome, and an Outcome cannot be read out of a result.
    call: readTool(['check', '--json'], { failsLoudly: true, says: checkSentence }),
  },
  show_check_result: {
    description:
      'The last Check Result: what every Installed Skill was at the moment one Check ran. ' +
      'It asks GitHub nothing and applies nothing.',
    properties: {},
    required: [],
    call: readTool(['check', '--last', '--json']),
  },
  show_global_instructions: {
    description:
      'The Global Instructions: their owner, whether the file is there, its sha256, ' +
      'and its content.',
    properties: {},
    required: [],
    call: readTool(['global', 'show', '--json']),
  },
  update_skill: {
    description: 'Update one Installed Skill from its upstream source, then link.',
    properties: { name: text('The Skill Name.') },
    required: ['name'],
    call: { mutates: true, tail: (args) => ['update', args['name'] ?? ''] },
  },
  remove_skill: {
    description: 'Remove one Installed Skill from the Nexus Lock, then link.',
    properties: { name: text('The Skill Name.') },
    required: ['name'],
    call: { mutates: true, tail: (args) => ['remove', args['name'] ?? ''] },
  },
  edit_global_instructions: {
    description:
      'Replace the Global Instructions whole. `ifMatch` is the sha256 the editor started ' +
      'from, so a change made elsewhere is refused rather than overwritten.',
    properties: {
      content: text('The whole new file.'),
      ifMatch: text('The sha256 this edit started from.'),
    },
    required: ['content', 'ifMatch'],
    call: {
      mutates: true,
      tail: (args) => ['global', 'edit', '--if-match', args['ifMatch'] ?? ''],
      stdin: 'content',
    },
  },
};

/** Whether a mutation runs now. Per server process, as the Python lock was. */
let mutating = false;

/**
 * How long one CLI child may run, in seconds. An install reaches the network,
 * so it is generous. Read once, when the server starts.
 */
let timeout = Number(DEFAULT_TIMEOUT);

/**
 * One plain sentence about a check that ran, for the text half of its result
 * (ADR 0009). Undefined when the run said nothing countable; the Envelope is
 * the text then.
 */
function checkSentence(envelope: Envelope): string | undefined {
  const document = envelope.json;
  if (!isObject(document)) return undefined;
  const counts = document['counts'];
  const checkedAt = document['checkedAt'];
  if (!isObject(counts) || typeof checkedAt !== 'string') return undefined;
  const current = whole(counts['current']);
  const behind = whole(counts['behind']);
  const unknown = whole(counts['unknown']);
  const total = current + behind + unknown;
  return (
    `${total} Installed Skill${total === 1 ? '' : 's'}: ${current} current, ` +
    `${behind} Behind, ${unknown} unknown. Checked ${checkedAt}.`
  );
}

/** A count as `%d` prints it; a count that is not there is zero. */
function whole(value: unknown): number {
  return Math.trunc(Number(value ?? 0));
}

/**
 * The last thing the CLI said on stderr, which is the sentence a person can
 * act on. A run that failed silently says so with its exit code.
 */
function failureSentence(envelope: Envelope): string {
  const lines = envelope.stderr.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  for (const line of lines.reverse()) {
    if (line.trim() !== '') return line.trim();
  }
  return `${envelope.command.join(' ')} exited ${envelope.exit} and said nothing`;
}

/**
 * The Envelope as an MCP result. `isError` is never set, because a CLI
 * refusal is an answer the page shows, not a fault of the tool. The text half
 * is the Envelope too, unless the tool has a sentence worth quoting.
 */
function envelopeResult(envelope: Envelope, says?: (envelope: Envelope) => string | undefined) {
  const sentence = says?.(envelope);
  return {
    content: [{ type: 'text', text: sentence ? sentence : JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

/** One tool call, as an MCP answer. */
async function callTool(name: unknown, args: Readonly<Record<string, unknown>>): Promise<Answer> {
  const tool = typeof name === 'string' && Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (tool === undefined) return refusal(INVALID_PARAMS, `no such tool: ${valueText(name)}`);
  for (const key of tool.required) {
    if (typeof args[key] !== 'string') {
      return refusal(INVALID_PARAMS, `${valueText(name)} needs ${key} as a string`);
    }
  }
  const call = tool.call;
  if (!call.mutates) {
    const envelope = await runCli(call.tail);
    if (call.failsLoudly && envelope.exit !== 0) {
      return refusal(INTERNAL_ERROR, failureSentence(envelope));
    }
    return { result: envelopeResult(envelope, call.says) };
  }

  // The CLI's own name checks are the only validation: the Skill Name is one
  // argv element and never reaches a shell.
  if (mutating) return refusal(BUSY, 'another change is already running');
  mutating = true;
  try {
    const strings = args as Readonly<Record<string, string>>;
    const input = call.stdin === undefined ? undefined : strings[call.stdin];
    return { result: envelopeResult(await runCli(call.tail(strings), input)) };
  } finally {
    mutating = false;
  }
}

/**
 * Run the CLI once and give its Envelope. A CLI failure never rejects: exit 1
 * is a refusal the page must show.
 *
 * On Linux the child leads a process group of its own, so the timeout ends
 * every program the CLI started (an `npx` that hangs on the network), not the
 * CLI alone, and the pipes close.
 */
function runCli(tail: readonly string[], input?: string): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...tail], {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: !WINDOWS,
      shell: false,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    // A child that ends before it reads its stdin closes the pipe under us;
    // its exit code says what happened.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input, 'utf8');

    let timedOut = false;
    let drain: NodeJS.Timeout | undefined;
    const seconds = timeout;
    const timer = setTimeout(
      () => {
        timedOut = true;
        stopTree(child);
        drain = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, DRAIN_MS);
      },
      Math.min(LONGEST_TIMER_MS, Math.max(0, seconds * 1000)),
    );

    child.on('error', (fault) => {
      clearTimeout(timer);
      clearTimeout(drain);
      reject(fault);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(drain);
      let stderr = Buffer.concat(err).toString('utf8');
      if (timedOut) {
        stderr += `nexus: command killed after ${floatText(seconds)} seconds (timeout)\n`;
      }
      const stdout = Buffer.concat(out).toString('utf8');
      const exit = timedOut ? TIMED_OUT : exitCode(code, signal);
      const command = [SHOWN_CLI, ...tail];
      const envelope: Envelope = { command, exit, stdout, stderr };
      resolve(exit === 0 ? withJson(envelope) : envelope);
    });
  });
}

/** The Envelope with `json` when stdout is one JSON document. */
function withJson(envelope: Envelope): Envelope {
  try {
    return { ...envelope, json: JSON.parse(envelope.stdout) };
  } catch {
    return envelope;
  }
}

/** The exit code, or minus the signal number when a signal ended the child. */
function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null ? undefined : constants.signals[signal];
  return number === undefined ? -1 : -number;
}

/**
 * End a child and every program it started. On Windows `taskkill /T /F`
 * ends the whole tree, which `kill` cannot: there is no process group there.
 */
function stopTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (WINDOWS) {
    const root = process.env['SystemRoot'] ?? 'C:\\Windows';
    const taskkill = spawn(
      join(root, 'System32', 'taskkill.exe'),
      ['/pid', String(pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true, shell: false },
    );
    taskkill.on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * `NEXUS_MCP_TIMEOUT` as Python's `float()` read it: a decimal number, or
 * `inf` for the longest wait there is. Undefined when it is no number at all,
 * and when it is empty, which the Python server refused at start too.
 */
function readTimeout(value: string | undefined): number | undefined {
  const given = value === undefined ? DEFAULT_TIMEOUT : value.trim();
  if (/^[+-]?(?:inf|infinity)$/i.test(given)) {
    return given.startsWith('-') ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(given)) return undefined;
  return Number(given);
}

/**
 * A number of seconds as Python's `str(float)` writes it, so the timeout
 * sentence keeps its bytes: `300.0`, `0.5`, `1e-05`, `1e+16`.
 */
function floatText(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return 'inf';
  if (value === Number.NEGATIVE_INFINITY) return '-inf';
  if (Object.is(value, -0)) return '-0.0';
  const [mantissa = '0', power = '0'] = value.toExponential().split('e');
  const exponent = Number(power);
  const sign = mantissa.startsWith('-') ? '-' : '';
  const digits = mantissa.replace('-', '').replace('.', '');
  if (exponent >= -4 && exponent < 16) {
    if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
    const integer = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
    const fraction = digits.slice(exponent + 1);
    return `${sign}${integer}.${fraction === '' ? '0' : fraction}`;
  }
  const shown = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  const size = String(Math.abs(exponent)).padStart(2, '0');
  return `${sign}${shown}e${exponent < 0 ? '-' : '+'}${size}`;
}

/** A value as Python's `%s` writes it, for the sentences that name one. */
function valueText(value: unknown): string {
  if (value === undefined || value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/** Whether Python would read a value as false: `x or {}` takes `{}` then. */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  return isObject(value) && Object.keys(value).length === 0;
}

function refusal(code: number, message: string): Answer {
  return { error: { code, message } };
}

/** The answer to one request. */
async function answerFor(request: Readonly<Record<string, unknown>>): Promise<Answer> {
  const method = request['method'];
  const rawParams = request['params'];
  const params = isEmptyValue(rawParams) ? {} : rawParams;
  switch (method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return {
        result: {
          tools: Object.entries(TOOLS).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
          })),
        },
      };
    case 'tools/call': {
      if (!isObject(params)) return refusal(INVALID_PARAMS, 'params must be an object');
      const given = params['arguments'];
      const args = isEmptyValue(given) ? {} : given;
      if (!isObject(args)) return refusal(INVALID_PARAMS, 'arguments must be an object');
      return callTool(params['name'], args);
    }
    default:
      return refusal(METHOD_NOT_FOUND, `no such method: ${valueText(method)}`);
  }
}

/**
 * Answer one request. Each runs on its own, so a slow CLI child never stops
 * this server from answering anything else; closing stdin ends the server
 * only once every call in flight has been answered.
 */
async function handle(request: Readonly<Record<string, unknown>>): Promise<void> {
  const id = request['id'];
  let answer: Answer;
  try {
    answer = await answerFor(request);
  } catch (fault) {
    const kind = fault instanceof Error ? fault.name : typeof fault;
    const message = fault instanceof Error ? fault.message : String(fault);
    answer = refusal(INTERNAL_ERROR, `${kind}: ${message}`);
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...answer })}\n`);
}

/** Serve the Host for as long as it holds stdin open. */
function main(): void {
  const read = readTimeout(process.env['NEXUS_MCP_TIMEOUT']);
  if (read === undefined || Number.isNaN(read)) {
    process.stderr.write(
      `nexus: NEXUS_MCP_TIMEOUT must be a number of seconds: ${process.env['NEXUS_MCP_TIMEOUT']}\n`,
    );
    process.exitCode = 1;
    return;
  }
  timeout = read;
  process.stderr.write('nexus: the Plugin Server is up\n');
  createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on(
    'line',
    (line) => {
      if (line.trim() === '') return;
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        process.stderr.write('nexus: a line on stdin was not JSON\n');
        return;
      }
      // A notification has no id and no answer: notifications/initialized is
      // the only one MCP sends here. A line that is JSON but no object is
      // no request at all.
      if (!isObject(request) || request['id'] === undefined || request['id'] === null) return;
      void handle(request);
    },
  );
}

main();
