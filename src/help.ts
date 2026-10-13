/**
 * `nexus help`: the text that names every command.
 *
 * The dispatch prints the same text on stderr as the usage refusal. It names
 * the one CLI form that works on every system, the form the Control Skills
 * and the README use: `node` with the entry under the Nexus home.
 */
import type { Command } from './cli.ts';

/** The help text, which is also the usage. */
export const HELP_TEXT = `Usage: nexus <bootstrap|setup|link|install|update|remove|new|list|check|global|help>
Run it as: node "$HOME/.nexus/src/nexus.js" <command>

bootstrap    Link only the Nexus control skills.
setup        Run one-time initialization with backups.
link         Reconcile Claude and Codex links from the lock.
install      Install selected skills from one source via upstream npx skills.
update       Update one installed skill and relink.
remove       Uninstall one installed skill and relink.
new          Reserve a custom skill directory.
list         Show installed, custom, and control skills: list [--json].
check        Ask GitHub which installed skills are behind: check [--json]; the last result: check --last [--json].
global       Show or replace the Global Instructions: global show [--json], global edit [--if-match <sha256>].
help         Show this text.
`;

/** Print the help text on stdout. */
export const help: Command = async () => {
  process.stdout.write(HELP_TEXT);
  return 0;
};
