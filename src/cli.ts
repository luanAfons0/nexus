/**
 * The Nexus CLI: read the command, run it, and give back its exit code.
 *
 * Each command is one module that exports a `Command`, and one row of
 * `COMMANDS` names it. The dispatch does what the Bash CLI's `main` does: a
 * missing or unknown command, or an argument to a command that takes none,
 * prints the usage on stderr and exits 2 before any command runs. Every other
 * argument is the command's own to read.
 */
import { check } from './check.ts';
import { help, HELP_TEXT } from './help.ts';
import { list } from './list.ts';
import { error } from './output.ts';

/** One command: it gets the arguments after its name and gives the exit code. */
export type Command = (args: readonly string[]) => Promise<number>;

/** A row of the dispatch. */
type Entry = {
  /** What runs the command. */
  readonly run: Command;
  /** False when any argument after the name is a usage refusal. */
  readonly takesArguments: boolean;
};

/**
 * A command the Node CLI does not run yet. The port grows beside the Bash CLI
 * (expand, then contract): each ticket swaps one of these for the real module.
 */
function notPorted(name: string): Command {
  return async () => {
    error(`${name} is not in the Node CLI yet; run scripts/nexus ${name}.`);
    return 1;
  };
}

const COMMANDS: ReadonlyMap<string, Entry> = new Map<string, Entry>([
  ['bootstrap', { run: notPorted('bootstrap'), takesArguments: false }],
  ['setup', { run: notPorted('setup'), takesArguments: false }],
  ['install', { run: notPorted('install'), takesArguments: true }],
  ['new', { run: notPorted('new'), takesArguments: true }],
  ['update', { run: notPorted('update'), takesArguments: true }],
  ['remove', { run: notPorted('remove'), takesArguments: true }],
  ['list', { run: list, takesArguments: true }],
  ['check', { run: check, takesArguments: true }],
  ['link', { run: notPorted('link'), takesArguments: false }],
  ['global', { run: notPorted('global'), takesArguments: true }],
  ['help', { run: help, takesArguments: false }],
  ['-h', { run: help, takesArguments: false }],
  ['--help', { run: help, takesArguments: false }],
]);

/** Run the CLI on its arguments, the words after `nexus`, and give the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv;
  const entry = name === undefined ? undefined : COMMANDS.get(name);
  if (entry === undefined || (!entry.takesArguments && args.length > 0)) {
    process.stderr.write(HELP_TEXT);
    return 2;
  }
  return entry.run(args);
}
