/**
 * Copy a tree with its metadata, as `cp -a` and `cp -aL` did for Setup.
 *
 * The Backup is a copy, never a move, and it is accepted only when its
 * manifest equals the source's (`backup-manifest.ts`). So this copier keeps
 * everything the manifest records: each entry's type and bytes, a symlink's
 * target bytes as it reads them (a trailing newline counts), the mode, the
 * owner and group where the system lets it, the modification time, and the
 * hard-link groups, which no Node copy function keeps. Names are bytes
 * (`Buffer`), because a file name need not be UTF-8.
 *
 * A time is written to the precision Node can write (`COPY_TIME_UNIT`), at
 * the middle of its unit, so that the rounding of the double that libuv
 * takes cannot carry it into the next unit. The manifest compares a copy at
 * that same precision; whatever this copier gets wrong, it refuses.
 *
 * On Windows a directory symlink with an absolute target, such as the
 * junction a Managed Link is there, is copied as a junction, which needs no
 * privilege; any other symlink needs the privilege a symlink needs there,
 * and its copy fails loudly without it. Windows has no owner to copy.
 */
import {
  chmodSync,
  constants,
  copyFileSync,
  linkSync,
  lchownSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  utimesSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { getSystemErrorMessage } from 'node:util';
import { floorDiv } from './backup-manifest.ts';

/**
 * The precision, in nanoseconds, to which this copier writes a time: one
 * microsecond, as libuv truncates it on Linux and macOS; ten on Windows,
 * where libuv writes in steps of about 1.6 microseconds.
 */
export const COPY_TIME_UNIT: bigint = process.platform === 'win32' ? 10_000n : 1_000n;

const WINDOWS = process.platform === 'win32';

/** What a copy gave: done, or the sentence that says what failed. */
export type CopyResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** How a tree is copied. */
export type CopyOptions = {
  /**
   * Follow every symlink and copy what it reaches (`cp -aL`), instead of
   * copying the symlink itself (`cp -a`). The tree must be validated first:
   * no broken, cyclic or escaping link (`skill-tree.ts`).
   */
  readonly dereference: boolean;
};

/**
 * Copy the contents of the directory `source` into the existing, empty
 * directory `destination`, then give `destination` the mode, owner and
 * times of `source`, as `cp -a source/. destination/` with `chmod`, `chown`
 * and `touch -r` from the source did.
 */
export function copyTree(source: string, destination: string, options: CopyOptions): CopyResult {
  const from = Buffer.from(source);
  const to = Buffer.from(destination);
  const groups = new Map<string, Buffer>();
  try {
    copyChildren(from, to, options, groups);
    const stats = readStats(from, true);
    copyAttributes(from, stats, to, { link: false, ownerRequired: true });
    return { ok: true };
  } catch (failure) {
    if (isCopyError(failure)) return { ok: false, error: failure.sentence };
    throw failure;
  }
}

/**
 * The time to hand to `utimes` for a time of `ns` nanoseconds: the middle of
 * its `COPY_TIME_UNIT`, in seconds.
 */
export function copyTime(ns: bigint): number {
  const middle = floorDiv(ns, COPY_TIME_UNIT) * COPY_TIME_UNIT + COPY_TIME_UNIT / 2n;
  const seconds = floorDiv(middle, 1_000_000_000n);
  return Number(seconds) + Number(middle - seconds * 1_000_000_000n) / 1e9;
}

/** A refusal raised inside the copy, carried out to `copyTree`. */
type CopyError = { readonly copyError: true; readonly sentence: string };

function isCopyError(value: unknown): value is CopyError {
  return (value as Partial<CopyError> | null)?.copyError === true;
}

/** Run `step`; a failure becomes the sentence that names `path`. */
function attempt<T>(path: Buffer, step: () => T): T {
  try {
    return step();
  } catch (failure) {
    throw copyFailure(path, failure);
  }
}

function copyFailure(path: Buffer, failure: unknown): CopyError {
  return { copyError: true, sentence: `cannot copy ${path.toString()}: ${reason(failure)}` };
}

function copyChildren(
  from: Buffer,
  to: Buffer,
  options: CopyOptions,
  groups: Map<string, Buffer>,
): void {
  const names = attempt(from, () => readdirSync(from, { encoding: 'buffer' }));
  names.sort(Buffer.compare);
  for (const name of names) {
    copyEntry(join(from, name), join(to, name), options, groups);
  }
}

function copyEntry(
  from: Buffer,
  to: Buffer,
  options: CopyOptions,
  groups: Map<string, Buffer>,
): void {
  const stats = readStats(from, options.dereference);
  if (stats.isDirectory()) {
    attempt(to, () => mkdirSync(to));
    copyChildren(from, to, options, groups);
    copyAttributes(from, stats, to, { link: false, ownerRequired: false });
  } else if (stats.isSymbolicLink()) {
    attempt(to, () => copySymlink(from, to));
    copyAttributes(from, stats, to, { link: true, ownerRequired: false });
  } else if (stats.isFile()) {
    const key = `${stats.dev}:${stats.ino}`;
    const first = groups.get(key);
    if (first !== undefined) {
      attempt(to, () => linkSync(first, to));
      return;
    }
    attempt(from, () => copyFileSync(from, to, constants.COPYFILE_EXCL));
    copyAttributes(from, stats, to, { link: false, ownerRequired: false });
    groups.set(key, to);
  } else {
    throw copyFailure(from, 'unsupported entry (device/FIFO/socket)');
  }
}

/** Make `to` a symlink with the target bytes of the symlink `from`. */
function copySymlink(from: Buffer, to: Buffer): void {
  const target = readlinkSync(from, { encoding: 'buffer' });
  if (!WINDOWS) {
    symlinkSync(target, to);
    return;
  }
  const text = target.toString();
  let directory = false;
  try {
    directory = statSync(from).isDirectory();
  } catch {
    directory = false;
  }
  if (directory && isAbsolute(text)) symlinkSync(text, to, 'junction');
  else symlinkSync(text, to, directory ? 'dir' : 'file');
}

/** How one entry's metadata is copied. */
type AttributeOptions = {
  /** The entry is a symlink: its own times are set, never its target's. */
  readonly link: boolean;
  /**
   * A failed change of owner fails the copy, as `chown --reference` did for
   * the root. Inside the tree it is left to the manifest, as `cp -a` did.
   */
  readonly ownerRequired: boolean;
};

function copyAttributes(
  from: Buffer,
  stats: BigIntStats,
  to: Buffer,
  options: AttributeOptions,
): void {
  if (!WINDOWS) {
    try {
      lchownSync(to, Number(stats.uid), Number(stats.gid));
    } catch (failure) {
      if (options.ownerRequired) throw copyFailure(to, failure);
    }
  }
  // Linux has no lchmod: a symlink's mode is fixed, so only the others get one.
  if (!options.link) attempt(to, () => chmodSync(to, Number(stats.mode & 0o7777n)));
  const atime = copyTime(stats.atimeNs);
  const mtime = copyTime(stats.mtimeNs);
  attempt(to, () => (options.link ? lutimesSync : utimesSync)(to, atime, mtime));
}

function readStats(path: Buffer, follow: boolean): BigIntStats {
  return attempt(path, () => (follow ? statSync : lstatSync)(path, { bigint: true }));
}

function join(parent: Buffer, name: Buffer): Buffer {
  return Buffer.concat([parent, Buffer.from(sep), name]);
}

/** The system's words for a failure, or the failure itself. */
function reason(failure: unknown): string {
  const errno = (failure as { errno?: unknown } | null)?.errno;
  if (typeof errno === 'number') {
    try {
      return getSystemErrorMessage(errno);
    } catch {
      // Fall through to the failure's own text.
    }
  }
  return failure instanceof Error ? failure.message : String(failure);
}
