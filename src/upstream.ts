/**
 * Upstream: find `npx`, run `npx skills`, and Publish the Upstream Lock it
 * wrote as the Nexus Lock, then link.
 *
 * `npx skills` owns the download and the Canonical Root, and it rewrites the
 * Upstream Lock, `~/.agents/.skill-lock.json`, as it goes. Nexus never trusts
 * that file as it stands: it takes a Snapshot of it, validates the Snapshot
 * as an exact version-3 lock, checks that every Skill it names has a
 * `SKILL.md`, and only then copies the Snapshot over the Nexus Lock through a
 * temporary file and one rename. Any refusal on the way leaves the Nexus Lock
 * byte-identical (ADR 0001). Install, Update and Remove all end here.
 *
 * `npx` is found on PATH; on Windows that finds `npx.cmd` (`run-program.ts`).
 * Under WSL a directory on a Windows Drive is passed over, so the `npx` of a
 * Windows Node is never taken (`windows-drives.ts`).
 * On Linux and macOS a PATH without it falls back to NVM, as a person's
 * shell would find it. NVM is a shell function, so that one step sources
 * `nvm.sh` in `bash` (in `/bin/sh` when there is no `bash`), and the PATH it
 * leaves is the PATH `npx` runs with. `dash` cannot run `nvm use`.
 *
 * Like the Bash CLI (`ensure_npx` and its upstream calls) this module prints
 * its own sentences, byte for byte, and `linkAll` prints its own.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isPresent } from './entries.ts';
import { fault, seamFailure } from './fault.ts';
import { linkAll } from './link.ts';
import { type NexusLock, readLock } from './lock.ts';
import { error } from './output.ts';
import type { Paths } from './paths.ts';
import { findProgram, runProgram } from './run-program.ts';
import { withoutWindowsDrives } from './windows-drives.ts';

/** The lock the fault point `install_snapshot_mutate` writes over the Upstream Lock. */
const BETA_LOCK = '{"version":3,"skills":{"beta":{}}}\n';

/** The `npx` Nexus runs, and the environment it runs with. */
export type Npx = {
  /** The full path of `npx`, or `npx.cmd` on Windows. */
  readonly program: string;
  /** The environment `npx` gets: the CLI's, with NVM's PATH when NVM found it. */
  readonly env: NodeJS.ProcessEnv;
};

/**
 * A last check before the Snapshot is Published. It gets the Snapshot's
 * path and the validated lock, and gives the sentence that refuses
 * publication, or undefined to let it go on.
 */
export type PublishCheck = (snapshot: string, lock: NexusLock) => string | undefined;

/** How one publication differs from Install's. */
export type PublishOptions = {
  /** A last check of the validated Snapshot; Update and Remove each pass one. */
  readonly check?: PublishCheck;
  /** True accepts a lock that selects no skills: Remove of the last skill. */
  readonly allowEmpty?: boolean;
};

/** The prefix of the Upstream Lock Snapshot in the Nexus home. */
const SNAPSHOT_PREFIX = '.nexus-install-lock.';

/** The prefix of the temporary copy beside the Nexus Lock. */
const COPY_PREFIX = '.nexus-install-copy.';

/** The characters of a temporary name's random part, as `mktemp` picks them. */
const NAME_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * In the NVM fallback: source `nvm.sh` (its output goes to stderr, so stdout
 * is the PATH alone), switch to the default Node, and print the PATH that
 * holds its `npx`. Any failed step is a non-zero exit.
 */
const NVM_SCRIPT = [
  '. "$1" >&2 || exit 1',
  'nvm use default >/dev/null 2>&1 || exit 1',
  'command -v npx >/dev/null 2>&1 || exit 1',
  'printf "%s" "$PATH"',
].join('\n');

/**
 * Find `npx`, as `ensure_npx` does: on PATH, else through NVM on Linux and
 * macOS. Say why not and give undefined when there is none.
 */
export function ensureNpx(paths: Paths, env: NodeJS.ProcessEnv = process.env): Npx | undefined {
  const onPath = findProgram('npx', withoutWindowsDrives(env.PATH ?? ''));
  if (onPath !== undefined) return { program: onPath, env: withoutStateHome(env) };

  const nvmDir =
    env.NVM_DIR === undefined || env.NVM_DIR === '' ? join(paths.home, '.nvm') : env.NVM_DIR;
  const nvmScript = join(nvmDir, 'nvm.sh');
  if (process.platform === 'win32' || !isFile(nvmScript)) {
    error('npx is unavailable and NVM was not found');
    return undefined;
  }
  const shell = findProgram('bash', env.PATH ?? '') ?? '/bin/sh';
  const run = runProgram(shell, ['-c', NVM_SCRIPT, 'nexus', nvmScript], { env });
  process.stderr.write(run.stderr);
  const program =
    run.status === 0 ? findProgram('npx', withoutWindowsDrives(run.stdout)) : undefined;
  if (program === undefined) {
    error('NVM loaded but npx is unavailable');
    return undefined;
  }
  return { program, env: withoutStateHome({ ...env, PATH: run.stdout }) };
}

/**
 * Run `npx` with `args`, sharing the CLI's terminal, and give its exit code
 * as a shell gives it. `XDG_STATE_HOME` is taken out of its environment, as
 * `env -u XDG_STATE_HOME` did, so `npx skills` keeps its lock in the one
 * place Nexus reads it.
 */
export function runNpx(npx: Npx, args: readonly string[]): number {
  const run = runProgram(npx.program, args, { env: npx.env, stdio: 'inherit' });
  // A program that could not start says why only here; inherit shows nothing.
  process.stderr.write(run.stderr);
  return run.status;
}

/**
 * Publish the Upstream Lock as the Nexus Lock, then link, as
 * `publish_upstream_lock_and_link` does, and give the exit code: 0, or 1
 * after every sentence that says why. Nothing is Published unless the
 * Snapshot passed every check, and every scratch file is removed or named.
 */
export function publishUpstreamLock(paths: Paths, options: PublishOptions = {}): number {
  let snapshot: string;
  try {
    snapshot = reserveScratch(paths.nexusHome, SNAPSHOT_PREFIX);
  } catch {
    error('cannot reserve upstream lock snapshot');
    return 1;
  }
  if (!copyExactly(paths.upstreamLock, snapshot)) {
    removeScratch(snapshot);
    error(`cannot snapshot upstream skill lock: ${paths.upstreamLock}`);
    return 1;
  }

  let status = validateAndPublish(paths, snapshot, options);
  if (!removeScratch(snapshot)) status = 1;
  return status;
}

/**
 * Every step between the Snapshot and its cleanup: validate, check each
 * `SKILL.md`, run the caller's check, Publish, and link.
 */
function validateAndPublish(paths: Paths, snapshot: string, options: PublishOptions): number {
  if (fault('install_snapshot_mutate')) writeFileSync(paths.upstreamLock, BETA_LOCK);
  const read = readLock(snapshot, paths.nexusHome);
  if (!read.ok) {
    for (const sentence of read.errors) error(sentence);
    error('upstream did not produce a valid version-3 skill lock');
    return 1;
  }
  const lock = read.lock;
  if (lock.names.length === 0 && options.allowEmpty !== true) {
    error('upstream skill lock selected no skills');
    return 1;
  }
  for (const name of lock.names) {
    const skillFile = join(paths.canonicalRoot, name, 'SKILL.md');
    if (!isFile(skillFile)) {
      error(`upstream lock skill is missing SKILL.md: ${skillFile}`);
      return 1;
    }
  }
  const refusal = options.check?.(snapshot, lock);
  if (refusal !== undefined) {
    error(refusal);
    return 1;
  }
  if (!publishCopy(snapshot, paths.lock)) return 1;
  return linkAll(paths, false) === 0 ? 0 : 1;
}

/**
 * Copy `source` over `destination` through a temporary file beside it and
 * one rename, verified before and after, as `upstream_atomic_lock_copy` does.
 */
function publishCopy(source: string, destination: string): boolean {
  const parent = dirname(destination);
  try {
    mkdirSync(parent, { recursive: true });
  } catch {
    error(`cannot create lock destination: ${parent}`);
    return false;
  }
  let temp: string;
  try {
    temp = reserveScratch(parent, COPY_PREFIX);
  } catch {
    error('cannot reserve atomic lock copy');
    return false;
  }
  if (!copyExactly(source, temp)) {
    if (!removeScratch(temp)) return false;
    error(`atomic upstream lock copy verification failed: ${destination}`);
    return false;
  }
  try {
    renameSync(temp, destination);
  } catch {
    if (!removeScratch(temp)) return false;
    error(`cannot publish upstream lock: ${destination}`);
    return false;
  }
  if (!sameBytes(source, destination)) {
    error(`upstream lock post-publication verification failed: ${destination}`);
    return false;
  }
  return true;
}

/**
 * Create an empty file `<dir>/<prefix>XXXXXX` that no one else holds, mode
 * 0600, as `mktemp` does, and give its path. It throws when it cannot.
 */
function reserveScratch(dir: string, prefix: string): string {
  for (let attempt = 0; ; attempt += 1) {
    const path = join(dir, prefix + randomName());
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return path;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 100) throw cause;
    }
  }
}

/**
 * Write the bytes of `source` into the existing file `destination`, which
 * keeps its own mode as `cp` onto a file does, then compare the two files.
 * False when either step fails, or the bytes differ.
 */
function copyExactly(source: string, destination: string): boolean {
  try {
    writeFileSync(destination, readFileSync(source));
  } catch {
    return false;
  }
  return sameBytes(source, destination);
}

/** True when both files can be read and hold the same bytes (`cmp -s`). */
function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Remove one scratch file, as `cleanup_upstream_snapshot` does. Nothing
 * there is success; a file that is still there after is named, and false.
 */
function removeScratch(path: string): boolean {
  if (!isPresent(path)) return true;
  try {
    if (fault('install_cleanup_fail')) seamFailure('install scratch cleanup failed');
    else rmSync(path, { force: true });
  } catch {
    // The check below says whether it is gone.
  }
  if (!isPresent(path)) return true;
  error(`install scratch retained: ${path}`);
  return false;
}

/** The environment without `XDG_STATE_HOME`, in any spelling Windows allows. */
function withoutStateHome(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(copy)) {
    if (key.toUpperCase() === 'XDG_STATE_HOME') delete copy[key];
  }
  return copy;
}

/** Six random characters for a temporary name. */
function randomName(): string {
  return [...randomBytes(6)].map((byte) => NAME_CHARACTERS[byte % NAME_CHARACTERS.length]).join('');
}

/** True for a regular file, following a symlink (`-f`). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
