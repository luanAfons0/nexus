/**
 * The behaviour of a fake `npx skills remove <name>`: the remove fake of
 * `tests/cases/remove.sh`. It deletes the skill from the Canonical Root and
 * from the Upstream Lock in the home it runs in, as upstream `npx skills`
 * would, and reaches no network.
 *
 * `NEXUS_FAKE_NPX_MODE` picks what it does:
 * - unset: deletes the skill's directory and its lock entry;
 * - `failure`: exits 42 and changes nothing;
 * - `keep`: exits 0 and changes nothing, so the name is still in the lock;
 * - `leave_directory`: deletes the lock entry, but leaves the directory.
 *
 * The lock is written as `jq 'del(.skills[$name])'` writes it: the same keys
 * in the same order, two spaces of indent.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agents = join(homedir(), '.agents');
const mode = process.env.NEXUS_FAKE_NPX_MODE ?? 'success';
const args = process.argv.slice(2);
const name = args[args.indexOf('remove') + 1] ?? '';

if (mode === 'failure') {
  process.exitCode = 42;
} else if (mode !== 'keep') {
  if (mode !== 'leave_directory') {
    rmSync(join(agents, 'skills', name), { recursive: true, force: true });
  }
  const file = join(agents, '.skill-lock.json');
  const document = JSON.parse(readFileSync(file, 'utf8')) as { skills: Record<string, unknown> };
  delete document.skills[name];
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
}
