/**
 * What is at a path, asked the two ways the Bash CLI asked it.
 *
 * `is…` looks at the entry itself and never follows a link, as `-L` and
 * `lstat` do: a symlink, or on Windows a junction, is what it is.
 * `reaches…` follows every link to what it reaches, as `-e`, `-d` and `-f`
 * do. The difference decides whether Nexus keeps or claims an entry, so each
 * call site says which one it means. A path that cannot be read is no entry
 * of any kind.
 */
import { type PathLike, lstatSync, readFileSync, statSync } from 'node:fs';

/** True when anything is at `path`, even a link that reaches nothing (`-e || -L`). */
export function isPresent(path: PathLike): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` is a symlink, or on Windows a junction, itself. */
export function isSymlink(path: PathLike): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when `path` is a directory itself, not a link to one. */
export function isPhysicalDirectory(path: PathLike): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `path` is a regular file itself, not a link to one. */
export function isRegularFile(path: PathLike): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when `path` reaches something, following every link (`-e`). */
export function reachesEntry(path: PathLike): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` reaches a directory, following every link (`-d`). */
export function reachesDirectory(path: PathLike): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `path` reaches a regular file, following every link (`-f`). */
export function reachesFile(path: PathLike): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when both files can be read and hold the same bytes. */
export function sameBytes(a: PathLike, b: PathLike): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}
