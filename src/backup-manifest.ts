/**
 * The Backup manifest: a record of every entry of an Agent Home tree, exact
 * enough that two equal manifests mean two trees a person cannot tell apart.
 *
 * This is the port of `scripts/lib/backup_manifest.py`. Setup takes one of
 * the source before the copy, one of the copy, and one of the source after,
 * and accepts the Backup only when they agree. Each entry records its type,
 * its relative path as bytes, its mode, owner, group and modification time
 * in nanoseconds; a symlink its target as bytes (a trailing newline counts);
 * a regular file its size, the first path of its hard-link group, and in a
 * full manifest the SHA-256 of its bytes. An absent root is one explicit
 * record: Setup takes it as an empty Backup. A device, FIFO or socket is
 * refused, because a Backup could not hold it.
 *
 * Paths are bytes throughout (`Buffer`), because a file name need not be
 * UTF-8 and a decoded name could not be opened again. Device and inode
 * numbers are `bigint`, because a Windows file ID does not fit a number.
 *
 * Node writes a modification time to the microsecond on Linux and macOS, and
 * in steps of about 1.6 microseconds on Windows (libuv takes the time as a
 * double), so a copy can never carry the source's nanoseconds. A manifest
 * is therefore compared at one of two precisions: the copier's
 * `COPY_TIME_UNIT` (`tree-copy.ts`) when a copy is held against its source,
 * and one nanosecond when the source is held against itself, which keeps
 * every sub-second change visible.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { sep } from 'node:path';
import { pyOsError, pyRepr } from './py-text.ts';

/** One entry of a tree, as the manifest records it. */
export type ManifestRecord = {
  /** `d` directory, `l` symlink, `f` regular file, `a` absent root. */
  readonly kind: 'd' | 'l' | 'f' | 'a';
  /** The path from the root, `.` for the root, `/` between names. */
  readonly rel: Buffer;
  /** The permission bits, `S_IMODE`. */
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly mtimeNs: bigint;
  /** A symlink's target, as bytes. */
  readonly target?: Buffer;
  /** A regular file's size. */
  readonly size?: bigint;
  /** The first path, in byte order, of the file's hard-link group in this tree. */
  readonly representative?: Buffer;
  /** The SHA-256 of a regular file, in a full manifest. */
  readonly digest?: Buffer;
};

/** Every entry of one tree, sorted by relative path bytes. */
export type Manifest = {
  readonly records: readonly ManifestRecord[];
};

/** What reading a manifest gave: the manifest, or the sentence that refuses it. */
export type ManifestRead =
  | { readonly ok: true; readonly manifest: Manifest }
  | { readonly ok: false; readonly error: string };

/** How two manifests are compared. */
export type Comparison = {
  /** Compare the files' SHA-256 too (a full manifest), not only their metadata. */
  readonly digests: boolean;
  /** The precision of a time, in nanoseconds. */
  readonly timeUnit: bigint;
};

/**
 * Read the manifest of the tree at `root`. With `digests`, every regular file
 * is read and hashed once per hard-link group; without, only metadata. The
 * error is the helper's sentence, without its `backup manifest: ` prefix.
 */
export function readManifest(root: string, digests: boolean): ManifestRead {
  const rootPath = Buffer.from(root);
  let rootStats: BigIntStats;
  try {
    rootStats = lstatSync(rootPath, { bigint: true });
  } catch {
    return {
      ok: true,
      manifest: { records: [{ kind: 'a', rel: Buffer.from('.'), mode: 0, uid: 0, gid: 0, mtimeNs: 0n }] },
    };
  }
  if (!rootStats.isDirectory()) {
    return { ok: false, error: `agent root is not a physical directory: ${pyRepr(rootPath)}` };
  }
  try {
    const entries = walk(rootPath);
    const groups = new Map<string, Buffer>();
    const hashes = new Map<string, Buffer>();
    const records = entries.map((entry) => record(entry, digests, groups, hashes));
    return { ok: true, manifest: { records } };
  } catch (failure) {
    if (isManifestError(failure)) return { ok: false, error: failure.sentence };
    throw failure;
  }
}

/** True when the two manifests say the same thing at the precision asked for. */
export function sameManifest(a: Manifest, b: Manifest, comparison: Comparison): boolean {
  return manifestBytes(a, comparison).equals(manifestBytes(b, comparison));
}

/**
 * One manifest as bytes, every field length-prefixed so that no two
 * different manifests give the same bytes (the helper's record format).
 */
function manifestBytes(manifest: Manifest, comparison: Comparison): Buffer {
  const parts: Buffer[] = [];
  for (const each of manifest.records) {
    const values: Buffer[] = [];
    if (each.kind !== 'a') {
      values.push(
        text(each.mode),
        text(each.uid),
        text(each.gid),
        text(floorDiv(each.mtimeNs, comparison.timeUnit)),
      );
    }
    if (each.kind === 'l') values.push(each.target ?? Buffer.alloc(0));
    if (each.kind === 'f') {
      values.push(text(each.size ?? 0n), each.representative ?? Buffer.alloc(0));
      if (comparison.digests) values.push(each.digest ?? Buffer.alloc(0));
    }
    const fields = [Buffer.from(each.kind), each.rel, ...values].map(field);
    const body = Buffer.concat([Buffer.from('NEXUS1\0'), ...fields]);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(body.length));
    parts.push(length, body);
  }
  return Buffer.concat(parts);
}

/** One entry met by the walk. */
type Entry = {
  readonly path: Buffer;
  readonly rel: Buffer;
  readonly stats: BigIntStats;
};

/** A refusal raised inside the walk, carried out to `readManifest`. */
type ManifestError = { readonly manifestError: true; readonly sentence: string };

function manifestError(sentence: string): ManifestError {
  return { manifestError: true, sentence };
}

function isManifestError(value: unknown): value is ManifestError {
  return (value as Partial<ManifestError> | null)?.manifestError === true;
}

/** Every entry under `root`, the root first, sorted by relative path bytes. */
function walk(root: Buffer): Entry[] {
  const entries: Entry[] = [];
  const visit = (path: Buffer, rel: Buffer): void => {
    let stats: BigIntStats;
    try {
      stats = lstatSync(path, { bigint: true });
    } catch (failure) {
      throw manifestError(`cannot lstat ${pyRepr(path)}: ${pyOsError(failure, path)}`);
    }
    entries.push({ path, rel, stats });
    if (!stats.isDirectory()) return;
    let names: Buffer[];
    try {
      names = readdirSync(path, { encoding: 'buffer' });
    } catch (failure) {
      throw manifestError(`cannot traverse ${pyRepr(path)}: ${pyOsError(failure, path)}`);
    }
    names.sort(Buffer.compare);
    for (const name of names) {
      const childRel = rel.equals(Buffer.from('.'))
        ? name
        : Buffer.concat([rel, Buffer.from('/'), name]);
      visit(Buffer.concat([path, Buffer.from(sep), name]), childRel);
    }
  };
  visit(root, Buffer.from('.'));
  return entries.sort((a, b) => Buffer.compare(a.rel, b.rel));
}

/** The record of one entry; hashes each hard-link group once. */
function record(
  entry: Entry,
  digests: boolean,
  groups: Map<string, Buffer>,
  hashes: Map<string, Buffer>,
): ManifestRecord {
  const { path, rel, stats } = entry;
  const common = {
    rel,
    mode: Number(stats.mode & 0o7777n),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    mtimeNs: stats.mtimeNs,
  };
  if (stats.isDirectory()) return { kind: 'd', ...common };
  if (stats.isSymbolicLink()) {
    let target: Buffer;
    try {
      target = readlinkSync(path, { encoding: 'buffer' });
    } catch (failure) {
      throw manifestError(`cannot read symlink ${pyRepr(path)}: ${pyOsError(failure, path)}`);
    }
    return { kind: 'l', ...common, target };
  }
  if (stats.isFile()) {
    const key = `${stats.dev}:${stats.ino}`;
    const representative = groups.get(key) ?? rel;
    groups.set(key, representative);
    let digest: Buffer | undefined;
    if (digests) {
      digest = hashes.get(key) ?? hashFile(path, stats);
      hashes.set(key, digest);
    }
    return { kind: 'f', ...common, size: stats.size, representative, digest };
  }
  throw manifestError(`unsupported agent backup entry (device/FIFO/socket): ${pyRepr(path)}`);
}

/**
 * The SHA-256 of the regular file at `path`, read through one descriptor
 * that is checked to be the file the walk saw, before and after.
 */
function hashFile(path: Buffer, seen: BigIntStats): Buffer {
  const changed = (): ManifestError => manifestError(`file changed while hashing: ${pyRepr(path)}`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (failure) {
    throw manifestError(`cannot read file ${pyRepr(path)}: ${pyOsError(failure, path)}`);
  }
  try {
    const checked = fstatSync(fd, { bigint: true });
    if (checked.dev !== seen.dev || checked.ino !== seen.ino || !checked.isFile()) throw changed();
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
    if (fstatSync(fd, { bigint: true }).size !== seen.size) throw changed();
    return hash.digest();
  } catch (failure) {
    if (isManifestError(failure)) throw failure;
    throw manifestError(`cannot read file ${pyRepr(path)}: ${pyOsError(failure, path)}`);
  } finally {
    closeSync(fd);
  }
}

/** A length-prefixed field: four bytes of length, big-endian, then the bytes. */
function field(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function text(value: number | bigint): Buffer {
  return Buffer.from(String(value));
}

/** `a / b` rounded down, also for a time before 1970. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}
