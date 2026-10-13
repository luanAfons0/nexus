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
import { globalInstructions } from './global.ts';
import { help, usageRefusal } from './help.ts';
import { install } from './install.ts';
import { bootstrap, link } from './link.ts';
import { list } from './list.ts';
import { newSkill } from './new.ts';
import { remove } from './remove.ts';
import { setup } from './setup.ts';
import { update } from './update.ts';

/** One command: it gets the arguments after its name and gives the exit code. */
export type Command = (args: readonly string[]) => Promise<number>;

/** A row of the dispatch. */
type Entry = {
  /** What runs the command. */
  readonly run: Command;
  /** False when any argument after the name is a usage refusal. */
  readonly takesArguments: boolean;
};

const COMMANDS: ReadonlyMap<string, Entry> = new Map<string, Entry>([
  ['bootstrap', { run: bootstrap, takesArguments: false }],
  ['setup', { run: setup, takesArguments: false }],
  ['install', { run: install, takesArguments: true }],
  ['new', { run: newSkill, takesArguments: true }],
  ['update', { run: update, takesArguments: true }],
  ['remove', { run: remove, takesArguments: true }],
  ['list', { run: list, takesArguments: true }],
  ['check', { run: check, takesArguments: true }],
  ['link', { run: link, takesArguments: false }],
  ['global', { run: globalInstructions, takesArguments: true }],
  ['help', { run: help, takesArguments: false }],
  ['-h', { run: help, takesArguments: false }],
  ['--help', { run: help, takesArguments: false }],
]);

/** Run the CLI on its arguments, the words after `nexus`, and give the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv;
  const entry = name === undefined ? undefined : COMMANDS.get(name);
  if (entry === undefined || (!entry.takesArguments && args.length > 0)) {
    return usageRefusal();
  }
  return entry.run(args);
}
