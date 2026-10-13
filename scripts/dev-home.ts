/**
 * Run the Nexus CLI against a throwaway home directory:
 * `node scripts/dev-home.ts [--reset] <nexus argument>...`.
 *
 * Every path Nexus touches is read from the home directory: the Canonical
 * Root, the Custom Root, both Native Skill Roots and both Instruction Paths.
 * Moving the home moves the whole Agent Context with it, so a contributor can
 * run setup, install or link for real without touching the context they work
 * in every day. The suite already drives the CLI this way; this is the same
 * seam for a person. It sets `HOME` and `USERPROFILE` both, because Node reads
 * the home from `HOME` on Linux and macOS and from `USERPROFILE` on Windows.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The file that marks a directory as a sandbox this script made. */
const MARKER = '.nexus-dev-home';

/** The directories a fresh sandbox holds, as a real home with both agents does. */
const ROOTS = ['.nexus', '.claude/skills', '.codex/skills', '.custom-skills', '.agents/skills'];

/** The repository this script belongs to. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: node scripts/dev-home.ts [--reset] <nexus argument>...
       node scripts/dev-home.ts [--reset]

Runs the Nexus CLI with its home pointed at a sandbox home directory, so no
command can reach your real Claude, Codex, Nexus or custom-skills files.

  --reset    Delete the sandbox home and build it again.

The sandbox is .scratch/home in this repository, which Git ignores. Set
NEXUS_DEV_HOME to put it somewhere else.

Examples:
  node scripts/dev-home.ts list
  node scripts/dev-home.ts setup
  node scripts/dev-home.ts --reset link
`;

/** Say why the script stopped, on stderr, and give the failure code. */
function fail(sentence: string): number {
  process.stderr.write(`dev-home: error: ${sentence}\n`);
  return 1;
}

/**
 * A path with every part that exists resolved to its physical form, as
 * `realpath -m` gives it: a symlink in the path cannot hide the real home.
 */
function physical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(physical(parent), basename(absolute));
}

/** Two paths as the file system compares them: without case on Windows. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The resolved sandbox, or undefined after a refusal. The sandbox must never
 * be the real home, or a parent of it: the whole point is that a bad change
 * cannot reach the Agent Context you use.
 */
function sandboxPath(chosen: string): string | undefined {
  if (chosen === '') {
    fail('the sandbox home is empty');
    return undefined;
  }
  const sandbox = physical(chosen);
  const real = physical(homedir());
  const holdsReal =
    samePath(sandbox, parse(sandbox).root) ||
    samePath(sandbox, real) ||
    samePath(real.slice(0, sandbox.length + 1), sandbox + sep);
  if (holdsReal) {
    fail(`the sandbox home may not hold your real home: ${sandbox}`);
    return undefined;
  }
  return sandbox;
}

/** Whether the sandbox carries the marker of this script. */
function marked(sandbox: string): boolean {
  return statSync(join(sandbox, MARKER), { throwIfNoEntry: false })?.isFile() === true;
}

/** Delete the sandbox, but only a directory this script marked as its own. */
function removeSandbox(sandbox: string): boolean {
  if (!existsSync(sandbox)) return true;
  if (!marked(sandbox)) {
    fail(`${sandbox} has no ${MARKER} marker, so it is not a sandbox this script made`);
    return false;
  }
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  return true;
}

/**
 * Build the sandbox: the empty roots Nexus expects and a copy of the Control
 * Skills, exactly as a real Nexus home holds them. The copy is refreshed on
 * every run, so an edit under skills/ is the one the sandbox sees.
 */
function buildSandbox(sandbox: string): boolean {
  if (existsSync(sandbox) && !marked(sandbox)) {
    fail(`${sandbox} already exists and has no ${MARKER} marker; move it aside first`);
    return false;
  }
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(join(sandbox, MARKER), '');
  for (const root of ROOTS) mkdirSync(join(sandbox, root), { recursive: true });
  const skills = join(sandbox, '.nexus', 'skills');
  rmSync(skills, { recursive: true, force: true, maxRetries: 3 });
  cpSync(join(REPO, 'skills'), skills, { recursive: true });
  return true;
}

/** Run the script, and give its exit code. */
function main(args: readonly string[]): number {
  let rest = args;
  let reset = false;
  if (rest[0] === '--reset') {
    reset = true;
    rest = rest.slice(1);
  } else if (rest[0] === '-h' || rest[0] === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const sandbox = sandboxPath(process.env.NEXUS_DEV_HOME ?? join(REPO, '.scratch', 'home'));
  if (sandbox === undefined) return 1;
  if (reset && !removeSandbox(sandbox)) return 1;
  if (!buildSandbox(sandbox)) return 1;

  if (rest.length === 0) {
    process.stdout.write(`dev-home: ${sandbox}\n`);
    if (reset) return 0;
    process.stderr.write(USAGE);
    return 2;
  }

  process.stderr.write(`dev-home: HOME=${sandbox}\n`);
  const run = spawnSync(process.execPath, [join(REPO, 'src', 'nexus.js'), ...rest], {
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, NEXUS_HOME: join(sandbox, '.nexus') },
    shell: false,
    stdio: 'inherit',
  });
  if (run.error !== undefined) return fail(`cannot run the Nexus CLI: ${run.error.message}`);
  return run.status ?? 1;
}

process.exitCode = main(process.argv.slice(2));
