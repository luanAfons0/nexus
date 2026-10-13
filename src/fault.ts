/**
 * Seam 3: named fault points. They took the place of the Bash function
 * overrides the Bash suite had, which a TypeScript CLI cannot have.
 *
 * A test sets `NEXUS_FAULT=<name>`, and the CLI fails, corrupts or pauses at
 * the one point that the name stands for, as the Bash override did. Each
 * point is one line in the code it tests. The CLI honours `NEXUS_FAULT` only
 * when `NEXUS_TEST_MODE=1` is set and the home holds the test-home marker
 * `.nexus-test-home`; anywhere else it changes nothing, so a fault can never
 * reach a person's Agent Context.
 *
 * A pause holds Setup in a window where a signal reached the Bash CLI. It
 * writes `<home>/<window>-handshake`, then waits for `<window>-release` or
 * `<window>-stop`. On Linux a test sends a real SIGTERM, then the release.
 * Windows runs no handler for a SIGTERM that another process sends, so there
 * a test writes the stop file, and the pause raises SIGTERM inside the CLI,
 * as the signal would have. Either way Setup sees the signal at its next
 * checkpoint.
 */
import { statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { error } from './output.ts';

/** The file that marks a home as a test home (`newHome` in `tests/helpers/nexus.ts` writes it). */
const MARKER = '.nexus-test-home';

/** How long a pause sleeps between two looks for its release, in milliseconds. */
const POLL_MS = 20;

/** The fault of this run: a name, none, or not read yet. */
let active: string | undefined | null = null;

/** True once a pause of this run has written its handshake. */
let held = false;

/** True when this run makes one of the faults `names`. */
export function fault(...names: readonly string[]): boolean {
  const name = activeFault();
  return name !== undefined && names.includes(name);
}

/** Say that a test seam failed, in the Bash overrides' words, and give false. */
export function seamFailure(what: string): false {
  error(`test seam: ${what}`);
  return false;
}

/** The path of `name` in the home: where a fault writes, or looks for, its files. */
export function homeFile(name: string): string {
  return join(homedir(), name);
}

/**
 * Hold the run in `window` until the test releases it or stops it. A stop
 * raises SIGTERM inside the CLI, for the systems where a test cannot.
 */
export function pause(window: string): void {
  writeFileSync(homeFile(`${window}-handshake`), '');
  held = true;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    if (isFile(homeFile(`${window}-stop`))) {
      process.emit('SIGTERM', 'SIGTERM');
      return;
    }
    if (isFile(homeFile(`${window}-release`))) return;
    Atomics.wait(sleeper, 0, 0, POLL_MS);
  }
}

/**
 * Make one change of a fault as the shell command of the Bash override made
 * it: a change that fails stops nothing (the command's own line is not said).
 */
export function tryChange(change: () => void): void {
  try {
    change();
  } catch {
    // As `chmod` or `rm` that failed inside the override: the override went on.
  }
}

/** True once a pause of this run has written its handshake. */
export function paused(): boolean {
  return held;
}

/** The fault `NEXUS_FAULT` names, when this run may honour it. */
function activeFault(): string | undefined {
  if (active === null) {
    const name = process.env.NEXUS_FAULT ?? '';
    const honoured = process.env.NEXUS_TEST_MODE === '1' && isFile(homeFile(MARKER));
    active = honoured && name !== '' ? name : undefined;
  }
  return active;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
