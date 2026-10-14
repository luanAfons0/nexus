/**
 * The two kinds of line the CLI says, in the form the Bash CLI says them:
 * `nexus: <message>` on stdout and `nexus: error: <message>` on stderr.
 *
 * An error is a sentence a person can act on, and names the path it is about.
 */

/** Say one line of progress on stdout. */
export function info(message: string): void {
  process.stdout.write(`nexus: ${message}\n`);
}

/**
 * Say one line of progress on stderr, where stdout must stay one JSON
 * document (`list --json`).
 */
export function note(message: string): void {
  process.stderr.write(`nexus: ${message}\n`);
}

/** Say one error on stderr. */
export function error(message: string): void {
  process.stderr.write(`nexus: error: ${message}\n`);
}

/** Say one error on stderr, and give false: the end of a step that failed. */
export function refuse(message: string): false {
  error(message);
  return false;
}
