/**
 * How a test looks at the Managed Links a run left in its home, and how it
 * runs the Bash CLI on a twin home to compare the bytes.
 *
 * These read files and spawn the Bash CLI only. They never import a Nexus
 * module, so the CLI stays the one seam (Seam 1).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Assert that `link` is a relative symlink that resolves to `expected`, as
 * `assert_link_to` and the relative-link checks of `tests/run.sh` do.
 */
export function assertLinkTo(link: string, expected: string): void {
  const text = linkText(link);
  assert.notEqual(text, undefined, `not a symlink: ${link}`);
  assert.equal(realpathSync.native(link), realpathSync.native(expected), `wrong target: ${link}`);
  assert.ok(!text?.startsWith('/'), `absolute link: ${link} -> ${text}`);
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
