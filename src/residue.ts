/**
 * The Residue of one Setup: every temporary path it made and every recovery
 * path it had to keep, so that a failed or interrupted Setup can remove what
 * is its own and name what it must leave for a person to review.
 *
 * A temp is a path Setup made and may remove: when Setup ends, each one
 * that sits where Setup makes its temps is removed, and any that stays is
 * named. A recovery path holds something a person may need back (a moved
 * Backup, a moved Canonical Root entry); Setup never removes it, and names
 * it when a signal stops Setup. These are the Bash CLI's
 * `SETUP_OWNED_TEMPS` and `SETUP_OWNED_RECOVERY`.
 */
import { rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isPresent, isRegularFile, reachesDirectory } from './entries.ts';
import { fault, paused, seamFailure } from './fault.ts';
import { error } from './output.ts';

/**
 * Give a signal its turn. Setup's work is synchronous, so a signal is seen
 * only where Setup awaits one of these; it throws when a signal stopped
 * Setup, and the Residue is then cleaned and named.
 */
export type Checkpoint = () => Promise<void>;

/** The paths one Setup made and has not yet removed. */
export type Residue = {
  /** Register a temp Setup made and may remove. */
  readonly temp: (path: string) => void;
  /** Register a recovery path Setup keeps for a person. */
  readonly recovery: (path: string) => void;
  /** Forget a path: it is gone, or it is no longer Setup's. */
  readonly forget: (path: string) => void;
  /** Every temp still registered, oldest first. */
  readonly temps: () => readonly string[];
  /** Every recovery path still registered, oldest first. */
  readonly recoveries: () => readonly string[];
};

/** An empty Residue. */
export function newResidue(): Residue {
  let temps: string[] = [];
  let recoveries: string[] = [];
  return {
    temp(path) {
      if (path !== '') temps.push(path);
    },
    recovery(path) {
      if (path !== '') recoveries.push(path);
    },
    forget(path) {
      temps = temps.filter((each) => each !== path);
      recoveries = recoveries.filter((each) => each !== path);
    },
    temps: () => [...temps],
    recoveries: () => [...recoveries],
  };
}

/** True when `path` is a directory Setup made in `parent` with `prefix` (`owned_setup_dir`). */
export function isOwnedDir(path: string, parent: string, prefix: string): boolean {
  return reachesDirectory(path) && dirname(path) === parent && basename(path).startsWith(prefix);
}

/**
 * Remove a directory Setup made in `parent` with `prefix`, and all it holds
 * (`cleanup_setup_dir`). Refuses, with a sentence, any other path. False
 * when it was refused or stays.
 */
export function removeOwnedDir(path: string, parent: string, prefix: string): boolean {
  if (!isOwnedDir(path, parent, prefix)) {
    error(`refusing to clean unowned setup path: ${path}`);
    return false;
  }
  return removeTree(path);
}

/**
 * Remove a temp file Setup made in `parent` with `prefix`, and forget it
 * (`cleanup_registered_setup_file`). A path already gone is forgotten. An
 * unowned path is refused with a sentence and stays registered, to be named.
 */
export function removeOwnedFile(
  residue: Residue,
  path: string,
  parent: string,
  prefix: string,
): boolean {
  if (!isPresent(path)) {
    residue.forget(path);
    return true;
  }
  if (!isRegularFile(path) || dirname(path) !== parent || !basename(path).startsWith(prefix)) {
    error(`refusing to clean unowned setup file: ${path}`);
    return false;
  }
  if (!removeTree(path) || isPresent(path)) return false;
  residue.forget(path);
  return true;
}

/** Remove `path` and all under it (`rm -rf`); false when it failed. */
export function removeTree(path: string): boolean {
  const snapshot = basename(path).startsWith('.nexus-lock.');
  if (fault('term_pre_cleanup_fail', 'term_post_cleanup_fail') && paused() && snapshot) {
    return seamFailure('lock snapshot cleanup failed');
  }
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}
