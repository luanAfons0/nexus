/**
 * `nexus global show [--json]` and `nexus global edit [--if-match <sha256>]`:
 * read the Global Instructions, and replace `GLOBAL.md`, the one path Nexus
 * writes in the Custom Root (ADR 0004).
 *
 * Every refusal happens before any change, so a refused edit leaves the
 * Custom Root byte-identical. The edit writes a temporary file beside
 * `GLOBAL.md` and renames it over the old one, so no reader ever sees half a
 * file. On Windows each Instruction Path is a Managed Copy (ADR 0010), so the
 * edit then brings both copies in step with the new file; a Foreign Entry is
 * kept. When `GLOBAL.md` is new, Link runs as `nexus link` does, so both
 * Instruction Paths reach it at once.
 *
 * The sentences, the output and the exit codes are the Bash CLI's
 * (`scripts/lib/global.sh`): output makes no terminal assumption, so the
 * Plugin Page drives the command as a subprocess.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Command } from './cli.ts';
import { customRootFault, globalInstructionsFault } from './custom.ts';
import { HELP_TEXT } from './help.ts';
import { globalInstructionsPresent, readGlobalInstructions } from './instructions.ts';
import { compactJson } from './json.ts';
import { refreshManagedCopies } from './link-primitive.ts';
import { linkAll } from './link.ts';
import { error } from './output.ts';
import { type Paths, readPaths } from './paths.ts';

/**
 * The SHA-256 of no bytes. An absent `GLOBAL.md` hashes as this too, so one
 * `--if-match` value says "I expect no content yet".
 */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The prefix of the temporary file an edit writes in the Custom Root. */
const TEMPORARY_PREFIX = '.nexus-tmp.global.';

/** `nexus global`: show or edit; anything else is the usage and exit 2. */
export const global: Command = async (args) => {
  const [action, ...rest] = args;
  if (action === 'show') return show(rest);
  if (action === 'edit') return edit(rest);
  process.stderr.write(HELP_TEXT);
  return 2;
};

/** Print `GLOBAL.md` as it is, or with `--json` one object about it. */
function show(args: readonly string[]): number {
  if (args.some((arg) => arg !== '--json')) return usage('global show accepts only --json');
  const paths = readPaths();
  if (!preflight(paths)) return 1;
  try {
    if (args.length > 0) {
      process.stdout.write(`${compactJson(readGlobalInstructions(paths, true))}\n`);
    } else if (globalInstructionsPresent(paths)) {
      process.stdout.write(readFileSync(paths.globalInstructions));
    }
  } catch {
    error(`cannot read the global instructions: ${paths.globalInstructions}`);
    return 1;
  }
  return 0;
}

/** Replace `GLOBAL.md` with stdin, then bring the Instruction Paths in step. */
async function edit(args: readonly string[]): Promise<number> {
  const parsed = parseEditArgs(args);
  if (typeof parsed === 'number') return parsed;
  const paths = readPaths();
  if (!preflight(paths)) return 1;
  const owner = paths.globalInstructions;
  const existed = globalInstructionsPresent(paths);
  if (parsed.ifMatch !== undefined) {
    let current: string;
    try {
      current = existed ? sha256(readFileSync(owner)) : EMPTY_SHA256;
    } catch {
      error(`cannot read the global instructions: ${owner}`);
      return 1;
    }
    if (current !== parsed.ifMatch) {
      error(
        'global instructions changed since they were read: ' +
          `expected sha256 ${parsed.ifMatch}, actual ${current}`,
      );
      return 1;
    }
  }

  const temporary = createTemporary(paths.customRoot);
  if (temporary === undefined) {
    error(`cannot create a temporary file in the custom skill root: ${paths.customRoot}`);
    return 1;
  }
  try {
    writeFileSync(temporary.fd, await readStdin());
  } catch {
    closeSync(temporary.fd);
    rmSync(temporary.path, { force: true });
    error('cannot read the new global instructions from stdin');
    return 1;
  }
  closeSync(temporary.fd);
  try {
    chmodSync(temporary.path, newMode(owner, existed));
  } catch {
    rmSync(temporary.path, { force: true });
    error(`cannot set the mode of ${temporary.path}`);
    return 1;
  }
  try {
    renameSync(temporary.path, owner);
  } catch {
    rmSync(temporary.path, { force: true });
    error(`cannot replace the global instructions: ${owner}`);
    return 1;
  }

  // On Linux and macOS each Instruction Path is a symlink that already reads
  // the new file, so this says nothing; on Windows it refreshes the copies.
  const failures = refreshManagedCopies(paths);
  for (const sentence of failures) error(sentence);
  const linked = existed ? 0 : linkAll(paths, false);
  return failures.length > 0 ? 1 : linked;
}

/** What `global edit` was asked, or the exit code of its usage refusal. */
type EditArgs = {
  /** The lower-case sha256 the current `GLOBAL.md` must have, if one was given. */
  readonly ifMatch: string | undefined;
};

function parseEditArgs(args: readonly string[]): EditArgs | number {
  let ifMatch: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== '--if-match') return usage('global edit accepts only --if-match <sha256>');
    const value = args[index + 1];
    if (value === undefined) return usage('global edit: --if-match requires a sha256 value');
    if (!/^[0-9a-fA-F]{64}$/.test(value)) {
      return usage(`global edit: --if-match requires a hex sha256, got: ${value}`);
    }
    ifMatch = value.toLowerCase();
  }
  return { ifMatch };
}

/** Say the refusal, then the usage, on stderr; the exit code is 2. */
function usage(sentence: string): number {
  error(sentence);
  process.stderr.write(HELP_TEXT);
  return 2;
}

/**
 * The Custom Root must be there and be a physical directory, and `GLOBAL.md`
 * absent or a regular file. Nexus never makes the Custom Root.
 */
function preflight(paths: Paths): boolean {
  if (!exists(paths.customRoot)) {
    error(`custom skill root is absent: ${paths.customRoot}`);
    return false;
  }
  for (const fault of [customRootFault(paths), globalInstructionsFault(paths)]) {
    if (fault !== undefined) {
      error(fault);
      return false;
    }
  }
  return true;
}

/** A new, empty temporary file in `dir`, mode 0600, as `mktemp` makes it. */
function createTemporary(dir: string): { readonly path: string; readonly fd: number } | undefined {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const path = join(dir, `${TEMPORARY_PREFIX}${randomName()}`);
    try {
      return { path, fd: openSync(path, 'wx', 0o600) };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
  }
  return undefined;
}

/** Six letters or digits, as `mktemp` puts in place of `XXXXXX`. */
function randomName(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(6)].map((byte) => letters[byte % letters.length]).join('');
}

/**
 * The mode of the new `GLOBAL.md`: the old file's, or for a new file what
 * the umask leaves of 0666, as the shell would create it.
 */
function newMode(owner: string, existed: boolean): number {
  if (existed) {
    try {
      return statSync(owner).mode & 0o7777;
    } catch {
      // The old file went while the edit ran: give the new one the umask mode.
    }
  }
  return 0o666 & ~process.umask();
}

/** Every byte on stdin, until its end. */
async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The SHA-256 of `bytes`, in hex. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** True when something, even a dangling link, is at `path` (`-e || -L`). */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
