/**
 * The one place Nexus starts an external program, such as `gh` or `npx`.
 *
 * A program is found on PATH and started as a path and an argument list,
 * with no shell, so no argument is ever read as shell syntax. Windows is the
 * one exception, and the only place a shell is used (spec #72): a `.cmd` or
 * `.bat` program, as npm installs `npx.cmd`, is a batch file that only
 * `cmd.exe` can run, and Node refuses to start one without a shell. So such a
 * program runs through `%ComSpec% /d /s /c "<line>"`, with every argument
 * quoted and every `cmd.exe` metacharacter escaped twice: once for the line
 * `cmd.exe` reads, and once for the line the batch file reads when it hands
 * its arguments on with `%*`.
 *
 * `spawn('gh')` cannot do the lookup itself: on Windows it tries `.exe` and
 * `.com` alone, and never finds a `.cmd`. So the lookup is Nexus's own, with
 * `PATHEXT` on Windows and the executable bit elsewhere, as `command -v` does.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

/** How a program's three streams are joined to the CLI's. */
export type ProgramStdio =
  /** stdin is empty; stdout and stderr come back as text. */
  | 'capture'
  /** The program shares the CLI's stdin, stdout and stderr. */
  | 'inherit'
  /** stdin is empty, and stdout and stderr go nowhere. */
  | 'ignore';

/** How one run of a program differs from a plain run. */
export type ProgramOptions = {
  /** The program's environment; the CLI's own when it is not given. */
  readonly env?: NodeJS.ProcessEnv;
  /** How the streams are joined; `capture` when it is not given. */
  readonly stdio?: ProgramStdio;
};

/** What one run of a program gave back. */
export type ProgramRun = {
  /**
   * The exit code as a shell gives it: the program's own, 128 plus the signal
   * number when a signal ended it, 126 when it could not be started, and 127
   * when it was not there to start.
   */
  readonly status: number;
  /** What it wrote on stdout; empty unless the stdio is `capture`. */
  readonly stdout: string;
  /** What it wrote on stderr, or why it could not start; empty unless `capture`. */
  readonly stderr: string;
};

/** The extensions Windows tries when `PATHEXT` is not set. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** The characters `cmd.exe` reads as syntax, which a caret makes plain. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * The full path of the program `name` on `searchPath` (the CLI's PATH when it
 * is not given), or undefined when there is none, as `command -v` answers. On
 * Windows each directory is tried with each extension of `PATHEXT`, in order;
 * elsewhere the first executable file wins. An empty entry is skipped, so the
 * current directory is never searched by accident.
 */
export function findProgram(
  name: string,
  searchPath: string = process.env.PATH ?? '',
): string | undefined {
  const windows = process.platform === 'win32';
  const extensions = windows ? windowsExtensions(name) : [''];
  for (const entry of searchPath.split(delimiter)) {
    const dir = windows ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (dir === '') continue;
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      if (isProgram(candidate)) return isAbsolute(candidate) ? candidate : resolve(candidate);
    }
  }
  return undefined;
}

/**
 * Run the program at `program`, a path `findProgram` gave, with `args`, and
 * wait for it to end. It never throws: a program that cannot start comes back
 * as status 126 or 127 with the reason on stderr, as a shell would say it.
 */
export function runProgram(
  program: string,
  args: readonly string[],
  options: ProgramOptions = {},
): ProgramRun {
  const stdio = options.stdio ?? 'capture';
  const viaCmd = process.platform === 'win32' && /^\.(cmd|bat)$/i.test(extname(program));
  const [file, argv] = viaCmd ? cmdLine(program, args) : [program, [...args]];
  const result = spawnSync(file, argv, {
    env: options.env ?? process.env,
    stdio: stdio === 'capture' ? ['ignore', 'pipe', 'pipe'] : stdio,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: viaCmd,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.error !== undefined && result.status === null && result.signal === null) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      status: code === 'ENOENT' ? 127 : 126,
      stdout,
      stderr: `${stderr}${program}: ${result.error.message}\n`,
    };
  }
  if (result.signal !== null) {
    return { status: 128 + (osConstants.signals[result.signal] ?? 0), stdout, stderr };
  }
  return { status: result.status ?? 1, stdout, stderr };
}

/** The extensions to try for `name` on Windows: none when it already has one. */
function windowsExtensions(name: string): readonly string[] {
  const listed = (process.env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(';')
    .filter((extension) => extension !== '');
  const own = extname(name).toUpperCase();
  if (own !== '' && listed.some((extension) => extension.toUpperCase() === own)) return [''];
  return listed;
}

/** True when `path` is a file this system would run. */
function isProgram(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `cmd.exe` and its arguments for one batch program. `/d` skips AutoRun, `/s`
 * takes the outer quotes off the line and nothing else, `/c` runs it and ends.
 */
function cmdLine(program: string, args: readonly string[]): [string, string[]] {
  // A Windows path holds no double quote, so quoting it is enough.
  const line = [`"${program}"`, ...args.map(cmdArgument)].join(' ');
  return [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`]];
}

/**
 * One argument, quoted as the C runtime reads a command line, then escaped
 * for `cmd.exe` twice, because a batch file that passes `%*` on makes
 * `cmd.exe` read the argument a second time.
 */
function cmdArgument(arg: string): string {
  // Backslashes before a quote, and before the closing quote, are doubled,
  // and an inner quote is escaped, so the program reads `arg` back exactly.
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}
