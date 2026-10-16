/**
 * Seam 3: named fault points. They took the place of the Bash function
 * overrides the Bash suite had, which a TypeScript CLI cannot have.
 *
 * A test sets `NEXUS_FAULT=<name>`, and the CLI fails, corrupts or pauses at
 * the one point that the name stands for, as the Bash override did. Each
 * point is one line in the code it tests; what a point changes in a tree is
 * in `fault-changes.ts`. The CLI honours `NEXUS_FAULT` only
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
import { appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { reachesFile } from './entries.ts';
import { FAULT_CHANGES } from './fault-changes.ts';
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

/**
 * Say that a test seam failed, in the Bash overrides' words, and give false.
 * `say` is how the caller says an error, when it also counts them.
 */
export function seamFailure(what: string, say: (message: string) => void = error): false {
  say(`test seam: ${what}`);
  return false;
}

/** Say that a test seam failed, and give undefined: for a step that gives a value. */
export function seamNothing(what: string): undefined {
  error(`test seam: ${what}`);
  return undefined;
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
    if (reachesFile(homeFile(`${window}-stop`))) {
      process.emit('SIGTERM', 'SIGTERM');
      return;
    }
    if (reachesFile(homeFile(`${window}-release`))) return;
    Atomics.wait(sleeper, 0, 0, POLL_MS);
  }
}

/**
 * Make at `path` the change the fault of this run stands for
 * (`fault-changes.ts`), on the Backup's attempt `attempt`.
 */
export function faultChange(path: string, attempt = 1): void {
  const name = activeFault();
  if (name !== undefined) FAULT_CHANGES[name]?.(path, attempt);
}

/** Add `line` to the file `name` in the home, where a case counts the calls a fault saw. */
export function recordCall(name: string, line: string): void {
  appendFileSync(homeFile(name), `${line}\n`);
}

/** True once a pause of this run has written its handshake. */
export function paused(): boolean {
  return held;
}

/**
 * True when this run may honour a test seam such as `NEXUS_FAULT`:
 * `NEXUS_TEST_MODE=1`, in a home that holds the test-home marker.
 */
export function inTestHome(): boolean {
  return process.env.NEXUS_TEST_MODE === '1' && reachesFile(homeFile(MARKER));
}

/** The fault `NEXUS_FAULT` names, when this run may honour it. */
function activeFault(): string | undefined {
  if (active === null) {
    const name = process.env.NEXUS_FAULT ?? '';
    active = inTestHome() && name !== '' ? name : undefined;
  }
  return active;
}
