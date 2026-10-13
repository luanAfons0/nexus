/**
 * How a test makes the links a home starts with, how it looks at the Managed
 * Links a run left there, and how it runs the Bash CLI on a twin home to
 * compare the bytes.
 *
 * A Managed Link is a relative symlink on Linux and macOS. On Windows it is a
 * junction to an Owner directory, or a Managed Copy of an Owner file, whose
 * SHA-256 the Managed Copies file of the Nexus home records (ADR 0010). A
 * test makes its own links the same way: a symlink, or on Windows a junction,
 * which needs no privilege, so every case runs on a Windows account as it is.
 *
 * These read and write files and spawn the Bash CLI and `fsutil` only. They
 * never import a Nexus module, so the CLI stays the one seam (Seam 1).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { snapshotTree } from './homes.ts';
import { fakePath, REPO_ROOT, type Run } from './nexus.ts';

/** True when nothing at all is at `path`, not even a dangling symlink. */
export function isAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch {
    return true;
  }
}

/** The raw text of the symlink at `path`, or undefined when it is no symlink. */
export function linkText(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/** True when the tests run on Windows, where a Managed Link is a junction or a copy. */
export const WINDOWS = process.platform === 'win32';

/**
 * Make a link at `path` whose text is `text`, as a person or an old Nexus
 * left it: a symlink, or on Windows a junction to the place `text` names
 * from the link's directory. A junction may point at a file or at nothing.
 */
export function makeLink(text: string, path: string): void {
  if (WINDOWS) symlinkSync(resolve(dirname(path), text), path, 'junction');
  else symlinkSync(text, path);
}

/** Assert that the link at `path` names `text`, as `makeLink` made it. */
export function assertLinkText(path: string, text: string): void {
  const expected = WINDOWS ? resolve(dirname(path), text) : text;
  assert.equal(linkText(path), expected, `wrong link text: ${path}`);
}

/**
 * Assert that `link` is a Managed Link that resolves to the directory
 * `expected`: a relative symlink, as `assert_link_to` and the relative-link
 * checks of `tests/run.sh` do, or on Windows a junction.
 */
export function assertLinkTo(link: string, expected: string): void {
  const text = linkText(link);
  assert.notEqual(text, undefined, `not a link: ${link}`);
  assert.equal(realpathSync.native(link), realpathSync.native(expected), `wrong target: ${link}`);
  if (WINDOWS) assert.ok(isJunction(link), `not a junction: ${link}`);
  else assert.ok(!isAbsolute(text ?? ''), `absolute link: ${link} -> ${text}`);
}

/**
 * True when the entry at `path` is a junction, a mount point reparse point,
 * as `fsutil` reads its tag. Node reads a junction and a symlink alike.
 */
export function isJunction(path: string): boolean {
  const run = spawnSync('fsutil', ['reparsepoint', 'query', path], { encoding: 'utf8' });
  return run.status === 0 && /0xa0000003\b/i.test(run.stdout);
}

/** The SHA-256 of the file at `path`, in hex. */
export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The Managed Copies file of the home `home`, as JSON, or `{}` when absent. */
export function managedCopies(home: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(home, '.nexus', 'managed-copies.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Assert that the Windows Instruction Path `path` is a Managed Copy of the
 * file `owner`: a regular file with the Owner's bytes, whose hash is recorded.
 */
export function assertManagedCopy(home: string, path: string, owner: string): void {
  assert.ok(lstatSync(path).isFile(), `not a regular file: ${path}`);
  assert.ok(readFileSync(path).equals(readFileSync(owner)), `not a copy of ${owner}: ${path}`);
  assert.equal(managedCopies(home)[path], sha256(path), `no record of ${path}`);
}

/** The trees a link run may touch. */
const AGENT_TREES: readonly string[] = ['.claude', '.codex', '.agents', '.custom-skills'];

/** The trees `dirs` of a home as one snapshot, to assert that nothing changed. */
export function agentTrees(home: string, dirs: readonly string[] = AGENT_TREES): string {
  return dirs.map((dir) => `${dir}:\n${snapshotTree(join(home, dir)).join('\n')}`).join('\n');
}

/** Run the Bash CLI on a test home, as `run_nexus` does, in the C locale. */
export function runBash(home: string, args: readonly string[]): Run {
  const result = spawnSync('bash', [join(REPO_ROOT, 'scripts', 'nexus'), ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, NEXUS_HOME: join(home, '.nexus'), LC_ALL: 'C' },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Run the Bash CLI on a test home as `runBash` does, with the home's fake
 * programs first on PATH and `extra` in its environment.
 */
export function runBashWithFakes(
  home: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): Run {
  const result = spawnSync('bash', [join(REPO_ROOT, 'scripts', 'nexus'), ...args], {
    cwd: home,
    env: {
      ...process.env,
      ...extra,
      PATH: fakePath(home, process.env.PATH ?? ''),
      HOME: home,
      NEXUS_HOME: join(home, '.nexus'),
      LC_ALL: 'C',
    },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The Bash CLI's stderr without the lines its tools print of their own: jq
 * before a lock sentence (with a random Snapshot path in it), and `realpath`
 * when `links_exactly_to` meets a dangling link. The port says only the
 * Nexus sentences.
 */
export function withoutToolNoise(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !line.startsWith('jq: ') && !line.startsWith('realpath: '))
    .join('\n');
}
