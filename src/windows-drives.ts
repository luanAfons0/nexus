/**
 * Windows Drives: under WSL, the Windows drives that Linux sees as mounts,
 * such as `/mnt/c`. A program on one is a Windows program. The `npx` of a
 * Windows Node is a `sh` script there: run from Linux it fails, or it works
 * on the Windows home and not on this one. A Host started from Windows gives
 * the Plugin Server a PATH with that `npx` on it and no NVM, so Nexus never
 * takes a program from a Windows Drive.
 *
 * WSL mounts each drive as `drvfs`: in WSL 2 a `9p` mount whose options hold
 * `aname=drvfs`, in WSL 1 a mount of the type `drvfs`. The mount table is
 * `/proc/mounts`. A test home may name another table in `NEXUS_TEST_MOUNTS`,
 * honoured only where `NEXUS_FAULT` is (`fault.ts`).
 */
import { readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { inTestHome } from './fault.ts';

/** The mount table Linux keeps for this process. */
const MOUNT_TABLE = '/proc/mounts';

/** `searchPath` without its directories on a Windows Drive. */
export function withoutWindowsDrives(searchPath: string): string {
  if (process.platform !== 'linux') return searchPath;
  const drives = windowsDrives();
  if (drives.length === 0) return searchPath;
  return searchPath
    .split(delimiter)
    .filter((dir) => dir === '' || !drives.some((drive) => within(resolve(dir), drive)))
    .join(delimiter);
}

/** The mount point of every Windows Drive, or none when the table cannot be read. */
function windowsDrives(): readonly string[] {
  const seam = process.env.NEXUS_TEST_MOUNTS ?? '';
  const table = seam !== '' && inTestHome() ? seam : MOUNT_TABLE;
  let text: string;
  try {
    text = readFileSync(table, 'utf8');
  } catch {
    return [];
  }
  const drives: string[] = [];
  for (const line of text.split('\n')) {
    const [, point, type, options = ''] = line.split(' ');
    if (point === undefined || type === undefined) continue;
    const wsl2 = type === '9p' && options.split(/[,;]/).includes('aname=drvfs');
    if (type === 'drvfs' || wsl2) drives.push(unescape(point));
  }
  return drives;
}

/** True when `dir` is `drive` or lies under it. */
function within(dir: string, drive: string): boolean {
  return dir === drive || dir.startsWith(drive.endsWith('/') ? drive : `${drive}/`);
}

/** A mount point as the table writes it, with `\040` for a space, read back. */
function unescape(point: string): string {
  return point.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}
