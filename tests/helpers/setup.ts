/**
 * How a test looks at what Setup left in its home, and how it runs the Bash
 * CLI's Setup on a twin home to compare the bytes and the trees.
 *
 * These read files and spawn programs only. They never import a Nexus
 * module, so the CLI stays the one seam (Seam 1).
 */
import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runBash } from './links.ts';
import { newHome, runNexus, type Run } from './nexus.ts';

/** The names a Setup temp or recovery path starts with (`assert_no_setup_residue`). */
const RESIDUE_PREFIXES: readonly string[] = [
  '.nexus-lock.',
  '.nexus-setup-backup.',
  '.nexus-setup-lock.',
  '.nexus-setup-source.',
  '.nexus-setup-copy.',
  '.nexus-canonical-tmp.',
  '.nexus-canonical-old.',
];

/**
 * Every path within three levels under `home` whose name a Setup temp or
 * recovery path has, as `assert_no_setup_residue` looks for them. Empty when
 * Setup left nothing.
 */
export function setupResidue(home: string, prefixes = RESIDUE_PREFIXES): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (prefixes.some((prefix) => name.startsWith(prefix))) found.push(path);
      if (isDirectory(path)) walk(path, depth + 1);
    }
  };
  walk(home, 1);
  return found;
}

/**
 * Every entry under `root` as `type|relative path|link target|mode`, sorted
 * by byte order: `snapshot_tree` with the permission bits, which a Backup
 * must keep. Names are read as bytes and written in hex where they are not
 * UTF-8, so a name no string can hold is still compared.
 */
export function detailedTree(root: string): readonly string[] {
  const lines: Buffer[] = [];
  const walk = (dir: Buffer, prefix: Buffer): void => {
    for (const name of readdirSync(dir, { encoding: 'buffer' })) {
      const path = Buffer.concat([dir, Buffer.from('/'), name]);
      const relative = prefix.length === 0 ? name : Buffer.concat([prefix, Buffer.from('/'), name]);
      const stats = lstatSync(path);
      const type = stats.isSymbolicLink() ? 'l' : stats.isDirectory() ? 'd' : 'f';
      const target = stats.isSymbolicLink()
        ? readlinkSync(path, { encoding: 'buffer' })
        : Buffer.alloc(0);
      const mode = stats.isSymbolicLink() ? '' : (stats.mode & 0o7777).toString(8);
      lines.push(
        Buffer.concat([
          Buffer.from(`${type}|`),
          relative,
          Buffer.from('|'),
          target,
          Buffer.from(`|${mode}`),
        ]),
      );
      if (stats.isDirectory()) walk(path, relative);
    }
  };
  try {
    if (!lstatSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  walk(Buffer.from(root), Buffer.alloc(0));
  return lines.sort(Buffer.compare).map(printable);
}

/** One line as text, with each byte that is not UTF-8 written as `\xNN`. */
function printable(line: Buffer): string {
  const text = line.toString('utf8');
  if (Buffer.from(text).equals(line)) return text;
  return [...line].map((byte) => (byte < 0x80 ? String.fromCharCode(byte) : `\\x${byte.toString(16)}`)).join('');
}

/** What one run of Setup left: the run, and the home it ran in. */
export type SetupRun = { readonly home: string; readonly run: Run };

/** Make a home with `build`, run Setup on it, and give back both. */
export function runSetup(name: string, build: (home: string) => void): SetupRun {
  const home = newHome(name);
  build(home);
  return { home, run: runNexus(home, ['setup']) };
}

/** The Bash CLI's lines that its tools print of their own; the port says only Nexus's. */
const TOOL_NOISE: readonly string[] = [
  'jq: ',
  'realpath: ',
  'mkdir: ',
  'cp: ',
  'mv: ',
  'stat: ',
  'find: ',
  'rmdir: ',
  'readlink: ',
];

/**
 * Build twin homes with `build`, run Setup through the Bash CLI on one and the
 * Node CLI on the other, and assert the same exit code, stdout, stderr and
 * trees. Each home path is written `<home>`, and the random part of a
 * Snapshot's name `XXXXXX`, before the bytes are compared.
 */
export function assertSetupSameAsBash(name: string, build: (home: string) => void): void {
  const bash = newHome(`${name}_bash`);
  const node = newHome(`${name}_node`);
  build(bash);
  build(node);
  const expected = runBash(bash, ['setup']);
  const actual = runNexus(node, ['setup']);
  const same = (text: string, home: string): string =>
    text
      .replaceAll(home, '<home>')
      .replace(/(\.nexus-lock(?:-candidates)?\.)[A-Za-z0-9]{6}/g, '$1XXXXXX');
  const quiet = (stderr: string): string =>
    stderr
      .split('\n')
      .filter((line) => !TOOL_NOISE.some((prefix) => line.startsWith(prefix)))
      .join('\n');
  assert.equal(actual.status, expected.status, `${name}: exit code`);
  assert.equal(same(actual.stdout, node), same(expected.stdout, bash), `${name}: stdout`);
  assert.equal(same(actual.stderr, node), same(quiet(expected.stderr), bash), `${name}: stderr`);
  assert.deepEqual(
    detailedTree(node).map((line) => same(line, node)),
    detailedTree(bash).map((line) => same(line, bash)),
    `${name}: trees`,
  );
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
