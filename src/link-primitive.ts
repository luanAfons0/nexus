/**
 * The Link primitive: the one module that knows the system (spec #72).
 *
 * Link and Bootstrap decide what to create, keep, replace or remove; this
 * module does the work that differs by system, behind six verbs. Everything
 * above it is system-free.
 *
 * On Linux and macOS a Managed Link is a relative symlink, staged under a
 * temporary name beside its path and renamed over it, so an agent never
 * sees a half-made link. An entry is managed when its link text reaches into
 * an Owner root (the Canonical Root, the Control Skills' root in the Nexus
 * home, or the Custom Root), read lexically or resolved, as the Bash CLI's
 * `is_managed_link` reads it (`scripts/lib/common.sh`).
 *
 * On Windows a symlink needs Developer Mode or an administrator, so Nexus
 * never makes one there (ADR 0010). A Managed Link to an Owner directory is a
 * junction, which needs neither; Node reads a junction as a symbolic link, so
 * the managed rule is the same. A Managed Link to an Owner file, the
 * Global Instructions, is a Managed Copy: a regular file whose bytes equal
 * the Owner's, and whose SHA-256 Nexus recorded when it wrote it, in the
 * Managed Copies file of the Nexus home. A file whose hash is not the record
 * is a Foreign Entry, so a hand edit is never overwritten.
 */
import { createHash, randomInt } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fault } from './fault.ts';
import type { Paths } from './paths.ts';
import { isWithin, realpathMissing, resolvedLinkTarget } from './real-paths.ts';

/**
 * What is at one Native Skill Root entry or Instruction Path:
 * - `nothing`: no entry at all;
 * - `managed`: a Managed Link (on Windows a junction or a Managed Copy) that
 *   Link may replace or remove;
 * - `foreign link`: a link that reaches no Owner root, kept as a Foreign Entry;
 * - `foreign`: a physical file or directory, kept as a Foreign Entry.
 */
export type Entry = 'nothing' | 'managed' | 'foreign link' | 'foreign';

/** A Managed Link made under a temporary name, or the sentence that refuses it. */
export type Staged =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

/** The work on Managed Links that differs by system. */
export type LinkPrimitive = {
  /** What is at `path`. */
  readonly read: (path: string) => Entry;
  /**
   * True when the entry at `path` is a Managed Link that already reaches
   * `owner` (`links_exactly_to`); for a Managed Copy, when its bytes equal
   * the Owner's and its hash is the record. Both must exist.
   */
  readonly reaches: (path: string, owner: string) => boolean;
  /**
   * Make a Managed Link to `owner` beside `path`, under a temporary name
   * `.nexus-tmp.*`, and verify that it reaches `owner`. The parent of `path`
   * must exist. A refused stage leaves nothing behind.
   */
  readonly stage: (owner: string, path: string) => Staged;
  /**
   * Put a staged link at `path`: `path` is free, a Managed Link, or (forced
   * by Setup) a link that reaches elsewhere. False when it failed, and then
   * what was at `path` is still there.
   */
  readonly promote: (staged: string, path: string) => boolean;
  /** Remove the Managed Link at `path`. False when it failed. */
  readonly remove: (path: string) => boolean;
  /** Remove a staged link that was not promoted, if it is still there. Silent. */
  readonly discard: (staged: string) => void;
};

/** The prefix of a staged link's name, beside the path it is for. */
export const STAGED_PREFIX = '.nexus-tmp.';

/**
 * The Managed Copies file in the Nexus home: the SHA-256 of each Managed
 * Copy Nexus wrote, by its path. Git ignores it, as it does the Check Result.
 * Only Windows writes it.
 */
export const MANAGED_COPIES_FILE = 'managed-copies.json';

/** The Link primitive of this system, for the Owner roots of `paths`. */
export function linkPrimitive(paths: Paths): LinkPrimitive {
  return process.platform === 'win32' ? windowsPrimitive(paths) : posixPrimitive(paths);
}

/**
 * Bring every Managed Copy at an Instruction Path back in step with
 * `GLOBAL.md`, and give the sentence of each failure. `nexus global edit`
 * calls it right after it replaces `GLOBAL.md` (#77). A Managed Link that
 * already reaches the Owner, which every symlink does, is left alone, so on
 * Linux and macOS it does nothing. A Foreign Entry, and an absent path, are
 * left alone everywhere: making a missing link is Link's work.
 */
export function refreshManagedCopies(paths: Paths): readonly string[] {
  const primitive = linkPrimitive(paths);
  const owner = paths.globalInstructions;
  const errors: string[] = [];
  for (const path of [paths.claudeInstructions, paths.codexInstructions]) {
    if (primitive.read(path) !== 'managed' || primitive.reaches(path, owner)) continue;
    const staged = primitive.stage(owner, path);
    if (!staged.ok) {
      errors.push(staged.error);
      continue;
    }
    if (!primitive.promote(staged.path, path)) {
      primitive.discard(staged.path);
      errors.push(`cannot install link: ${path}`);
    } else if (!primitive.reaches(path, owner)) {
      errors.push(`link verification failed: ${path}`);
    }
  }
  return errors;
}

/** Relative symlinks, as the Bash CLI makes them. */
function posixPrimitive(paths: Paths): LinkPrimitive {
  const isManagedLink = managedLinkRule(paths);
  const reaches = (path: string, owner: string): boolean => isLinkTo(path, owner);
  return {
    read: (path) => readLinkOrEntry(path, isManagedLink),
    reaches,
    stage(owner, path) {
      const parent = dirname(path);
      let text: string;
      try {
        // As `realpath --relative-to`: both ends physical, so a symlinked
        // Agent Home or Owner root still gives a link that reaches.
        text = relative(realpathSync.native(parent), realpathSync.native(owner)) || '.';
      } catch {
        return { ok: false, error: `cannot calculate relative target for ${path}` };
      }
      const staged = stagedName(path);
      try {
        symlinkSync(text, staged);
      } catch {
        return { ok: false, error: `cannot create temporary link for ${path}` };
      }
      if (!reaches(staged, owner)) {
        discardLink(staged);
        return { ok: false, error: `staged link verification failed: ${path}` };
      }
      return { ok: true, path: staged };
    },
    promote(staged, path) {
      try {
        renameSync(staged, path);
        return true;
      } catch {
        return false;
      }
    },
    remove(path) {
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },
    discard: discardLink,
  };
}

/**
 * Junctions to Owner directories and Managed Copies of Owner files. Windows
 * cannot rename over a directory, nor over a junction, so a promote that
 * finds an entry at its path first moves it aside under a staged name, and
 * puts it back when the staged link cannot take its place.
 */
function windowsPrimitive(paths: Paths): LinkPrimitive {
  const isManagedLink = managedLinkRule(paths);
  const record = managedCopies(join(paths.nexusHome, MANAGED_COPIES_FILE));
  const isManagedCopy = (path: string): boolean => {
    const hash = sha256(path);
    return hash !== undefined && record.read()[path] === hash;
  };
  return {
    read(path) {
      const entry = readLinkOrEntry(path, isManagedLink);
      return entry === 'foreign' && isFile(path) && isManagedCopy(path) ? 'managed' : entry;
    },
    reaches(path, owner) {
      if (isDirectory(owner)) return isLinkTo(path, owner);
      return isFile(path) && sameBytes(path, owner) && isManagedCopy(path);
    },
    stage(owner, path) {
      if (!isDirectory(owner)) return stageCopy(owner, path);
      let target: string;
      try {
        target = realpathSync.native(owner);
      } catch {
        return { ok: false, error: `cannot calculate relative target for ${path}` };
      }
      const staged = stagedName(path);
      try {
        symlinkSync(target, staged, 'junction');
      } catch {
        return { ok: false, error: `cannot create temporary link for ${path}` };
      }
      if (!isLinkTo(staged, owner)) {
        discardLink(staged);
        return { ok: false, error: `staged link verification failed: ${path}` };
      }
      return { ok: true, path: staged };
    },
    promote(staged, path) {
      const copy = isFile(staged);
      // A copy renames over a copy in one step; anything else moves aside.
      const aside = exists(path) && !(copy && isFile(path)) ? stagedName(path) : undefined;
      if (aside !== undefined && !move(path, aside)) return false;
      if (!move(staged, path)) {
        if (aside !== undefined) move(aside, path);
        return false;
      }
      if (aside !== undefined) discardLink(aside);
      if (!copy) return record.forget(path);
      const hash = sha256(path);
      if (hash !== undefined && record.remember(path, hash)) return true;
      // An unrecorded copy would read as a Foreign Entry: take it back.
      discardLink(path);
      return false;
    },
    remove(path) {
      try {
        unlinkSync(path);
      } catch {
        return false;
      }
      return record.forget(path);
    },
    discard: discardLink,
  };
}

/** Stage a copy of the Owner file `owner` beside `path`, and verify its bytes. */
function stageCopy(owner: string, path: string): Staged {
  const staged = stagedName(path);
  try {
    writeFileSync(staged, readFileSync(owner), { flag: 'wx' });
  } catch {
    discardLink(staged);
    return { ok: false, error: `cannot create temporary link for ${path}` };
  }
  if (!sameBytes(staged, owner)) {
    discardLink(staged);
    return { ok: false, error: `staged link verification failed: ${path}` };
  }
  return { ok: true, path: staged };
}

/** The Managed Copies file, read fresh each time and replaced whole. */
type ManagedCopies = {
  /** The recorded hash of each Managed Copy, by its path. */
  readonly read: () => Readonly<Record<string, string>>;
  /** Record `hash` for `path`. False when the file could not be written. */
  readonly remember: (path: string, hash: string) => boolean;
  /** Drop the record of `path`. False when the file could not be written. */
  readonly forget: (path: string) => boolean;
};

function managedCopies(file: string): ManagedCopies {
  // A missing or unreadable file records nothing, so every copy reads as a
  // Foreign Entry and is kept: the safe side of not knowing.
  const read = (): Record<string, string> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
      );
    } catch {
      return {};
    }
  };
  const write = (copies: Record<string, string>): boolean => {
    const staged = stagedName(file);
    try {
      writeFileSync(staged, `${JSON.stringify(copies, null, 2)}\n`, { flag: 'wx' });
      renameSync(staged, file);
      return true;
    } catch {
      discardLink(staged);
      return false;
    }
  };
  return {
    read,
    remember(path, hash) {
      const copies = read();
      if (copies[path] === hash) return true;
      copies[path] = hash;
      return write(copies);
    },
    forget(path) {
      const copies = read();
      if (!(path in copies)) return true;
      delete copies[path];
      return write(copies);
    },
  };
}

/** The entry at `path`, links judged by `isManagedLink`. */
function readLinkOrEntry(path: string, isManagedLink: (link: string) => boolean): Entry {
  let isLink: boolean;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return 'nothing';
  }
  if (!isLink) return 'foreign';
  return isManagedLink(path) ? 'managed' : 'foreign link';
}

/**
 * The rule that a link is managed: its text, read lexically from the link's
 * directory or resolved, lies inside an Owner root. Each root is taken as
 * written, physical (`realpath -m`), and native, which on Windows expands an
 * 8.3 short name the way a junction's text holds it.
 */
function managedLinkRule(paths: Paths): (link: string) => boolean {
  const roots = [paths.canonicalRoot, paths.controlRoot, paths.customRoot].flatMap((root) =>
    [resolve(root), physical(root), native(root)].filter((form) => form !== undefined),
  );
  const isManagedPath = (path: string): boolean => {
    const candidates = [resolve(path), physical(path)].filter((form) => form !== undefined);
    return roots.some((root) => candidates.some((candidate) => within(candidate, root)));
  };
  return (link) => {
    let text: string;
    try {
      text = readlinkSync(link);
    } catch {
      return false;
    }
    const resolved = resolvedLinkTarget(link);
    if (resolved === undefined) return false;
    return isManagedPath(resolve(dirname(link), text)) || isManagedPath(resolved);
  };
}

/** `isWithin`, but Windows paths compare without case, as Windows reads them. */
function within(candidate: string, root: string): boolean {
  if (process.platform !== 'win32') return isWithin(candidate, root);
  return isWithin(candidate.toLowerCase(), root.toLowerCase());
}

/** True when `path` is a link whose physical form is `owner`'s. */
function isLinkTo(path: string, owner: string): boolean {
  if (fault('verify')) return false;
  try {
    return (
      lstatSync(path).isSymbolicLink() && realpathSync.native(path) === realpathSync.native(owner)
    );
  } catch {
    return false;
  }
}

/** A fresh staged name beside `path`. */
function stagedName(path: string): string {
  return join(dirname(path), `${STAGED_PREFIX}${process.pid}.${randomInt(32768)}`);
}

/**
 * Remove the link, junction or staged copy at `path`, if it is one. Never a
 * directory: a junction is removed as the link it is, and never followed.
 */
function discardLink(path: string): void {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || stats.isFile()) unlinkSync(path);
  } catch {
    // Nothing is there, or nothing can be done: a staged name says what it is.
  }
}

/** Rename `from` to `to`; false when it failed. */
function move(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/** The SHA-256 of the file at `path`, in hex, or undefined when unreadable. */
function sha256(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

/** True when both files can be read and hold the same bytes. */
function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** True when something, even a dangling link, is at `path`. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` is a regular file itself, not through a link. */
function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when `path` is a directory, following a link (`-d`). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `realpath -m` of `path`, or undefined when its links loop. */
function physical(path: string): string | undefined {
  try {
    return realpathMissing(path);
  } catch {
    return undefined;
  }
}

/** The native real path of `path`, or undefined when it does not exist. */
function native(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}
