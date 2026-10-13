/**
 * Validate a skill tree before Setup follows its symlinks.
 *
 * When Setup turns a symlinked Canonical Root entry into a physical copy
 * (`cp -aL`), every symlink inside the skill is followed. So first each one
 * must resolve, must not loop, and must stay inside the skill: a link that
 * escapes would copy a file from elsewhere on the machine into the skill.
 * This is the port of `scripts/lib/validate_skill_tree.py`, and its
 * sentences are that helper's, printed as it printed them, with no prefix.
 *
 * Paths are bytes throughout (`Buffer`), because a file name need not be
 * UTF-8. Entries are met in the order the system lists them, as Python's
 * `os.scandir` met them; `readdirSync` would sort them (libuv's `scandir`).
 */
import { type Dirent, lstatSync, opendirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * The sentence that refuses the skill tree at `target`, or undefined when
 * every symlink in it resolves inside it.
 */
export function skillTreeFault(target: string): string | undefined {
  if (!isPhysicalDirectory(target)) return `skill source is not a physical directory: ${target}`;
  const skillFile = join(target, 'SKILL.md');
  if (!isPhysicalFile(skillFile)) return `skill source must contain a physical SKILL.md: ${target}`;
  const root = realpathSync.native(Buffer.from(target), { encoding: 'buffer' });
  return walk(Buffer.from(target), root, new Set());
}

/** The first fault under `directory`, or undefined. `active` holds the directories being walked. */
function walk(directory: Buffer, root: Buffer, active: Set<string>): string | undefined {
  let real: Buffer;
  try {
    real = realpathSync.native(directory, { encoding: 'buffer' });
  } catch {
    return `skill source cannot be traversed: ${directory}`;
  }
  const key = real.toString('latin1');
  if (active.has(key)) return `skill source has cyclic symlinked directory: ${directory}`;
  active.add(key);
  try {
    const entries = listInSystemOrder(directory);
    if (entries === undefined) return `skill source cannot be traversed: ${directory}`;
    for (const item of entries) {
      const entry = Buffer.concat([directory, Buffer.from(sep), item.name]);
      if (item.isSymbolicLink()) {
        if (!exists(entry)) return `skill source has broken or cyclic symlink: ${entry}`;
        const resolved = realpathSync.native(entry, { encoding: 'buffer' });
        if (!within(resolved, root)) {
          return `skill source symlink escapes skill tree: ${entry} -> ${resolved}`;
        }
        if (isDirectory(entry)) {
          const fault = walk(resolved, root, active);
          if (fault !== undefined) return fault;
        }
      } else if (item.isDirectory()) {
        const fault = walk(entry, root, active);
        if (fault !== undefined) return fault;
      }
    }
    return undefined;
  } finally {
    active.delete(key);
  }
}

/**
 * The entries of `directory` in the order the system lists them, or
 * undefined when it cannot be read.
 */
export function listInSystemOrder(directory: Buffer): Dirent<Buffer>[] | undefined {
  try {
    // Node gives each name as bytes with `buffer`, though its types allow only text encodings.
    const dir = opendirSync(directory, { encoding: 'buffer' as BufferEncoding });
    const entries: Dirent<Buffer>[] = [];
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        entries.push(entry as unknown as Dirent<Buffer>);
      }
    } finally {
      dir.closeSync();
    }
    return entries;
  } catch {
    return undefined;
  }
}

/** True when `path` is `root` or lies under it, as Python's `commonpath` decides it. */
function within(path: Buffer, root: Buffer): boolean {
  if (path.equals(root)) return true;
  const prefix = Buffer.concat([root, Buffer.from(sep)]);
  return path.length > prefix.length && path.subarray(0, prefix.length).equals(prefix);
}

/** True when `path` exists, following links (`os.path.exists`). */
function exists(path: Buffer): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: Buffer): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A directory that is not a symlink (`isdir` and not `islink`). */
function isPhysicalDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A regular file that is not a symlink (`isfile` and not `islink`). */
function isPhysicalFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
