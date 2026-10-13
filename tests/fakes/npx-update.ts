/**
 * The behaviour of a fake `npx skills update`: the update fake of
 * `tests/cases/update.sh`. It writes the Canonical Root and the Upstream Lock
 * in the home it runs in, as upstream `npx skills` would, and reaches no
 * network.
 *
 * `NEXUS_FAKE_NPX_MODE` picks what it does:
 * - unset: updates `alpha`, and writes a lock with its new hash `hash-new`;
 * - `failure`: exits 42 and writes nothing;
 * - `drops_name`: writes a lock that names `beta` alone;
 * - `invalid_lock`: writes `{bad`, which is no JSON;
 * - `missing_skill_md`: deletes `alpha`, but writes a lock that names it.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agents = join(homedir(), '.agents');
const mode = process.env.NEXUS_FAKE_NPX_MODE ?? 'success';

/** Write one skill directory with a SKILL.md that holds its name. */
function skill(name: string): void {
  mkdirSync(join(agents, 'skills', name), { recursive: true });
  writeFileSync(join(agents, 'skills', name, 'SKILL.md'), name);
}

/** Write the Upstream Lock, one line as `printf '%s\n'` writes it. */
function lock(text: string): void {
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, '.skill-lock.json'), `${text}\n`);
}

if (mode === 'failure') {
  process.exitCode = 42;
} else if (mode === 'drops_name') {
  skill('beta');
  lock('{"version":3,"skills":{"beta":{"skillFolderHash":"hash-beta"}}}');
} else if (mode === 'invalid_lock') {
  lock('{bad');
} else if (mode === 'missing_skill_md') {
  rmSync(join(agents, 'skills', 'alpha'), { recursive: true, force: true });
  lock('{"version":3,"skills":{"alpha":{"skillFolderHash":"hash-new"}}}');
} else {
  skill('alpha');
  lock(
    '{"version":3,"skills":{"alpha":{"skillFolderHash":"hash-new",' +
      '"updatedAt":"2026-02-02T00:00:00Z"}}}',
  );
}
