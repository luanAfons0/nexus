/**
 * A move that never replaces what is at its destination, as `mv -Tn` did
 * for the Bash CLI.
 *
 * Node has no rename that refuses an existing name, and a check before the
 * rename leaves a moment in which a Backup or a Foreign Entry can appear and
 * be replaced: on Linux and macOS a rename silently replaces an empty
 * directory, and on Windows it replaces a file. So the destination is first
 * reserved in one exclusive step, an empty directory or an empty file that
 * fails when anything at all is there, and the rename then replaces only
 * that reservation. Anything that got in meanwhile makes the rename fail.
 * The reservation is the one form each system lets a rename replace: an
 * empty directory for a directory on Linux and macOS; an empty file for
 * everything else, and for everything on Windows, which renames no directory
 * over a directory.
 */
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { entryIdentity } from './identity.ts';

/**
 * Rename `source` to `destination` only when nothing is at `destination`.
 * False when anything was there, or the rename failed; then `source` and
 * whatever was at `destination` are as they were.
 */
export function moveOntoNothing(source: string, destination: string): boolean {
  let directory: boolean;
  try {
    directory = lstatSync(source).isDirectory() && process.platform !== 'win32';
  } catch {
    return false;
  }
  try {
    if (directory) mkdirSync(destination);
    else closeSync(openSync(destination, 'wx'));
  } catch {
    return false;
  }
  const reservation = entryIdentity(destination, false);
  try {
    renameSync(source, destination);
    return true;
  } catch {
    // Take back only the reservation itself, never what took its place.
    if (reservation !== undefined && entryIdentity(destination, false) === reservation) {
      try {
        if (directory) rmdirSync(destination);
        else unlinkSync(destination);
      } catch {
        // The reservation stays: an empty entry that names nothing.
      }
    }
    return false;
  }
}
