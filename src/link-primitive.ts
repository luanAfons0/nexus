/**
 * The Link primitive: the one module that knows the system (spec #72).
 *
 * Link and Bootstrap decide what to create, keep, replace or remove; this
 * module does the work that differs by system, behind five verbs. Everything
 * above it is system-free, so the Windows half (#76: junctions for skill
 * directories, Managed Copies for Instruction Paths) changes this file alone.
 *
 * On Linux and macOS a Managed Link is a relative symlink, staged under a
 * temporary name beside its path and renamed over it, so an agent never
 * sees a half-made link. An entry is managed when its link text reaches into
 * an Owner root (the Canonical Root, the Control Skills' root in the Nexus
 * home, or the Custom Root), read lexically or resolved, as the Bash CLI's
 * `is_managed_link` reads it (`scripts/lib/common.sh`).
 */
import { randomInt } from 'node:crypto';
import {
  lstatSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Paths } from './paths.ts';
import { isWithin, realpathMissing, resolvedLinkTarget } from './real-paths.ts';

/**
 * What is at one Native Skill Root entry or Instruction Path:
 * - `nothing`: no entry at all;
 * - `managed`: a Managed Link (on Windows also a Managed Copy) that Link may
 *   replace or remove;
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
   * True when the entry at `path` is a link that already reaches `owner`
   * (`links_exactly_to`). Both must exist.
   */
  readonly reaches: (path: string, owner: string) => boolean;
  /**
   * Make a Managed Link to `owner` beside `path`, under a temporary name
   * `.nexus-tmp.*`, and verify that it reaches `owner`. The parent of `path`
   * must exist. A refused stage leaves nothing behind.
   */
  readonly stage: (owner: string, path: string) => Staged;
  /**
   * Put a staged link at `path` in one step: `path` is free, a Managed Link,
   * or (forced by Setup) a link that reaches elsewhere. False when it failed.
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
 * The sentence that refuses `command` on a system the primitive does not
 * serve yet, or undefined. Windows waits for junctions and Managed Copies
 * (#76), and until then refuses before anything changes.
 */
export function unsupportedSystem(command: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return `${command} does not run on Windows yet; run Nexus inside WSL for now`;
}

/** The Link primitive of this system, for the Owner roots of `paths`. */
export function linkPrimitive(paths: Paths): LinkPrimitive {
  const roots = [paths.canonicalRoot, paths.controlRoot, paths.customRoot];
  const isManagedPath = (path: string): boolean => {
    const candidates = [resolve(path), physical(path)];
    return roots.some((root) => {
      const forms = [resolve(root), physical(root)];
      return candidates.some((candidate) =>
        forms.some(
          (form) => candidate !== undefined && form !== undefined && isWithin(candidate, form),
        ),
      );
    });
  };
  const isManagedLink = (link: string): boolean => {
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

  return {
    read(path) {
      let isLink: boolean;
      try {
        isLink = lstatSync(path).isSymbolicLink();
      } catch {
        return 'nothing';
      }
      if (!isLink) return 'foreign';
      return isManagedLink(path) ? 'managed' : 'foreign link';
    },
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
      const staged = join(parent, `${STAGED_PREFIX}${process.pid}.${randomInt(32768)}`);
      try {
        symlinkSync(text, staged);
      } catch {
        return { ok: false, error: `cannot create temporary link for ${path}` };
      }
      if (!reaches(staged, owner)) {
        discard(staged);
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
    discard,
  };
}

/** True when `path` is a link whose physical form is `owner`'s. */
function reaches(path: string, owner: string): boolean {
  try {
    return (
      lstatSync(path).isSymbolicLink() && realpathSync.native(path) === realpathSync.native(owner)
    );
  } catch {
    return false;
  }
}

/** Remove the staged link at `staged`, if it is still a link. */
function discard(staged: string): void {
  try {
    if (lstatSync(staged).isSymbolicLink()) unlinkSync(staged);
  } catch {
    // Nothing is there, or nothing can be done: its name says what it is.
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
