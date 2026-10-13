/**
 * How a fault case runs the Bash CLI with the same fault, to compare the
 * bytes and the trees with the Node CLI's: the Bash CLI and its overrides in
 * `tests/faults.sh` are the specification of every fault point.
 *
 * These spawn programs and read files only. They never import a Nexus
 * module, so the CLI stays the one seam (Seam 1).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { newHome, REPO_ROOT, type Run, runNexus } from './nexus.ts';
import { detailedTree } from './setup.ts';

/** The Bash CLI's lines that its tools print of their own; the port says only Nexus's. */
const TOOL_NOISE = /^(jq|realpath|mkdir|cp|mv|stat|find|rmdir|readlink|rm): /;

/**
 * The manifest files the Bash CLI wrote in a Backup transaction directory.
 * The port keeps its manifests in memory, so a retained transaction holds
 * only the Backups.
 */
const MANIFEST_FILE = /^f\|\.nexus-setup-backup\.X\/(claude|codex)\.(source|copied)\./;

/**
 * Run the Bash CLI on a test home with the fault override `fault`, as
 * `run_nexus_overridden` in `tests/run.sh` does, in the C locale.
 */
export function runBashFault(home: string, fault: string, args: readonly string[]): Run {
  const script = 'source "$1"; nexus_init; source "$2"; fault_setup; main "${@:3}"';
  const cli = join(REPO_ROOT, 'scripts', 'nexus');
  const faults = join(REPO_ROOT, 'tests', 'faults.sh');
  const result = spawnSync('bash', ['-c', script, 'bash', cli, faults, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      NEXUS_HOME: join(home, '.nexus'),
      NEXUS_FAULT: fault,
      LC_ALL: 'C',
    },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Build twin homes with `build`, run `args` with the fault `fault` through
 * the Bash CLI on one and the Node CLI on the other, and assert the same exit
 * code, stdout, stderr and trees. Each home path is written `<home>`, and the
 * random part of a temp's name `X`, before the bytes are compared.
 */
export function assertFaultSameAsBash(
  fault: string,
  args: readonly string[],
  build: (home: string) => void,
): void {
  const bash = newHome(`${fault}_parity_bash`);
  const node = newHome(`${fault}_parity_node`);
  build(bash);
  build(node);
  const expected = runBashFault(bash, fault, args);
  const actual = runNexus(node, args, { env: { NEXUS_FAULT: fault } });
  const same = (text: string, home: string): string =>
    text
      .replaceAll(home, '<home>')
      .replace(/\.(nexus-[a-z-]+)\.[A-Za-z0-9.]+/g, '.$1.X')
      .split('\n')
      .filter((line) => !TOOL_NOISE.test(line))
      .join('\n');
  assert.equal(actual.status, expected.status, `${fault}: exit code\n${actual.stderr}`);
  assert.equal(same(actual.stdout, node), same(expected.stdout, bash), `${fault}: stdout`);
  assert.equal(same(actual.stderr, node), same(expected.stderr, bash), `${fault}: stderr`);
  assert.deepEqual(
    detailedTree(node).map((line) => same(line, node)),
    detailedTree(bash)
      .map((line) => same(line, bash))
      .filter((line) => !MANIFEST_FILE.test(line)),
    `${fault}: trees`,
  );
}
