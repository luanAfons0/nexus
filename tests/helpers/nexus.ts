/**
 * Seam 1: the Nexus CLI as a subprocess, against a home of the test's own.
 *
 * Every test makes a home under one temporary root, marks it as a test home,
 * and drives the CLI with `process.execPath` and no shell, exactly as a
 * person or the Plugin Server does. No test imports a Nexus module: the
 * command line and the files it leaves in the home are the whole seam, which
 * is what lets the inside of Nexus be rewritten. The helper refuses to run the
 * CLI against any directory that is not a marked home under the temporary
 * root, so no test can reach a real Agent Context.
 *
 * A fake program (`gh`, `npx`) is a Node script, put first on PATH as a POSIX
 * `sh` launcher and as a `.cmd` launcher for Windows. It records every call,
 * then runs a behaviour script from `tests/fakes/`.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root of the repository under test. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The CLI entry, as a person runs it: `node <CLI> <command>`. */
export const CLI = join(REPO_ROOT, 'src', 'nexus.js');

/** The directory of the behaviour scripts a fake program can run. */
export const FAKES = join(REPO_ROOT, 'tests', 'fakes');

/** The file that marks a directory as a home this helper made. */
const MARKER = '.nexus-test-home';

/** The directory in a test home that the helper puts first on PATH. */
const FAKE_BIN = 'fakebin';

// The native realpath, because on Windows the temporary directory can hold
// 8.3 short names that only the native call expands.
const TEST_ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexus-test-')));
process.on('exit', () => {
  rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 3 });
});

/** What a run of the CLI left behind for a person to see. */
export type Run = {
  /** The exit code, or null when a signal ended the CLI. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** How one run differs from a plain run. */
export type RunOptions = {
  /** More environment variables. A `PATH` here replaces the inherited one. */
  readonly env?: Readonly<Record<string, string>>;
  /** Node options, given before the CLI entry. */
  readonly node?: readonly string[];
  /** Bytes for the CLI's stdin. */
  readonly input?: string;
  /** False to run without `NEXUS_TEST_MODE=1`, which the fault points need. */
  readonly testMode?: boolean;
  /**
   * True to hide the test-home marker for this one run, after the home was
   * checked, so that the CLI sees a home that is not marked.
   */
  readonly unmarked?: boolean;
};

/** A run of the CLI that goes on while the test acts on it. */
export type Started = {
  /** The CLI's process: a test may send it a signal. */
  readonly child: ChildProcess;
  /** What the run left, once the CLI has ended. */
  readonly done: Promise<Run>;
};

/** The temporary root every test home lives under. */
export function testRoot(): string {
  return TEST_ROOT;
}

/**
 * Make a test home: the marker, a Nexus home, and a copy of the Control
 * Skills in it, as an installed Nexus holds them.
 */
export function newHome(name: string): string {
  const home = join(TEST_ROOT, name);
  mkdirSync(join(home, '.nexus'), { recursive: true });
  writeFileSync(join(home, MARKER), '');
  cpSync(join(REPO_ROOT, 'skills'), join(home, '.nexus', 'skills'), { recursive: true });
  return home;
}

/** Run the CLI against a test home, with its fake programs first on PATH. */
export function runNexus(home: string, args: readonly string[], options: RunOptions = {}): Run {
  const resolved = testHome(home);
  const env = environment(resolved, options);
  const marker = join(resolved, MARKER);
  const hidden = `${marker}.hidden`;
  if (options.unmarked === true) renameSync(marker, hidden);
  try {
    const result = spawnSync(process.execPath, [...(options.node ?? []), CLI, ...args], {
      cwd: resolved,
      env,
      encoding: 'utf8',
      input: options.input,
      shell: false,
      windowsHide: true,
    });
    if (result.error !== undefined) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    if (options.unmarked === true) renameSync(hidden, marker);
  }
}

/**
 * Start the CLI against a test home, as `runNexus` runs it, and give it back
 * while it runs: a test waits for a fault point's handshake, then signals or
 * releases it (`start_nexus_overridden` in `tests/run.sh`).
 */
export function startNexus(
  home: string,
  args: readonly string[],
  options: Pick<RunOptions, 'env'> = {},
): Started {
  const resolved = testHome(home);
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: resolved,
    env: environment(resolved, options),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<Run>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { child, done };
}

/**
 * Put a fake program first on the PATH of a test home. It records every call,
 * then runs `behaviour`, a script in `tests/fakes/`, with the same arguments.
 */
export function installFake(home: string, name: string, behaviour = 'succeed.ts'): void {
  const bin = join(testHome(home), FAKE_BIN);
  mkdirSync(bin, { recursive: true });
  const command = [process.execPath, join(FAKES, 'fake.ts'), callsFile(bin, name)];
  const script = join(FAKES, behaviour);
  const posix = [...command, script].map(shellQuote).join(' ');
  writeFileSync(join(bin, name), `#!/bin/sh\nexec ${posix} "$@"\n`);
  chmodSync(join(bin, name), 0o755);
  const windows = [...command, script].map((part) => `"${part}"`).join(' ');
  writeFileSync(join(bin, `${name}.cmd`), `@${windows} %*\r\n`);
}

/** Every call a fake program got, oldest first, each as its argument list. */
export function fakeCalls(home: string, name: string): readonly (readonly string[])[] {
  const file = callsFile(join(testHome(home), FAKE_BIN), name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[]);
}

/** The PATH a test home's runs get: its fake programs, then `path`. */
export function fakePath(home: string, path: string): string {
  // An empty PATH entry would mean the current directory, so none is left.
  return [join(testHome(home), FAKE_BIN), path].filter((part) => part !== '').join(delimiter);
}

/**
 * The environment a run against a test home gets, as `runNexus` builds it:
 * the home's fake programs first on PATH, and HOME and the Nexus home moved
 * into the test home. It refuses a home that is not a marked test home.
 */
export function homeEnvironment(
  home: string,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return environment(testHome(home), { env: extra });
}

/** The resolved home, or a refusal when it is not a marked home under the root. */
function testHome(home: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(home);
  } catch {
    throw new Error(`refusing to run outside a validated test home: ${home}`);
  }
  if (!resolved.startsWith(TEST_ROOT + sep) || !existsSync(join(resolved, MARKER))) {
    throw new Error(`refusing to run outside a validated test home: ${home}`);
  }
  return resolved;
}

/** The environment of one run: the inherited one, moved to the test home. */
function environment(home: string, options: RunOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(options.env ?? {})) set(env, name, value);
  set(env, 'PATH', fakePath(home, read(env, 'PATH') ?? ''));
  set(env, 'HOME', home);
  set(env, 'USERPROFILE', home);
  set(env, 'NEXUS_HOME', join(home, '.nexus'));
  set(env, 'NEXUS_TEST_MODE', '1');
  if (options.testMode === false) unset(env, 'NEXUS_TEST_MODE');
  return env;
}

/** Read a variable; on Windows its name has no case. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((each) => same(each, name));
  return key === undefined ? undefined : env[key];
}

/** Set a variable, so that on Windows no second spelling of it is left. */
function set(env: NodeJS.ProcessEnv, name: string, value: string): void {
  for (const key of Object.keys(env)) if (same(key, name)) delete env[key];
  env[name] = value;
}

/** Remove a variable, every spelling of it on Windows. */
function unset(env: NodeJS.ProcessEnv, name: string): void {
  for (const key of Object.keys(env)) if (same(key, name)) delete env[key];
}

function same(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toUpperCase() === b.toUpperCase() : a === b;
}

function callsFile(bin: string, name: string): string {
  return join(bin, `${name}.calls.jsonl`);
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
