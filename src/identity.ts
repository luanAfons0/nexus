/**
 * What makes an entry the same entry that was checked a moment ago.
 *
 * Setup moves a verified Backup tree and a validated Canonical Root entry,
 * and must know that what it moved is what it checked. An inode number alone
 * does not tell: ext4 hands a freed inode straight back to the next entry
 * made in its place, so an entry deleted and replaced between the check and
 * the move keeps its device and inode (#67; tmpfs never reuses an inode,
 * which is why a tmpfs home never showed it). The entry's type, and for a
 * symlink the text it holds, are what make a replacement visible. Device
 * and inode are read as `bigint`, because a Windows file ID does not fit a
 * number. This is the Bash CLI's `stat -c '%d:%i:%F'` and
 * `canonical_identity` (`scripts/lib/setup.sh`).
 */
import { lstatSync, readlinkSync, statSync, type BigIntStats } from 'node:fs';

/**
 * The identity of the entry at `path`, without following it: device, inode
 * and type, and with `linkTarget` a symlink's text too. Undefined when the
 * entry cannot be read.
 */
export function entryIdentity(path: string, linkTarget: boolean): string | undefined {
  let stats: BigIntStats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
  const identity = `${stats.dev}:${stats.ino}:${typeName(stats)}`;
  if (!linkTarget || !stats.isSymbolicLink()) return identity;
  try {
    return `${identity}:${readlinkSync(path, { encoding: 'buffer' }).toString('latin1')}`;
  } catch {
    return undefined;
  }
}

/**
 * The device and inode of what `path` reaches, following a symlink
 * (`stat -c '%d:%i'`). Undefined when it cannot be read.
 */
export function reachedIdentity(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
}

/** The type as `stat -c %F` names it. */
function typeName(stats: BigIntStats): string {
  if (stats.isSymbolicLink()) return 'symbolic link';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return stats.size === 0n ? 'regular empty file' : 'regular file';
  if (stats.isFIFO()) return 'fifo';
  if (stats.isSocket()) return 'socket';
  if (stats.isCharacterDevice()) return 'character special file';
  if (stats.isBlockDevice()) return 'block special file';
  return 'weird file';
}
