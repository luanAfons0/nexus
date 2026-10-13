/**
 * The behaviour of a fake `npx skills add`: the install fake of
 * `tests/run.sh`. It writes the Canonical Root and the Upstream Lock in the
 * home it runs in, as upstream `npx skills` would, and reaches no network.
 *
 * `NEXUS_FAKE_NPX_MODE` picks what it does:
 * - unset: installs `alpha` and `beta`, and writes a lock that names both;
 * - `failure`: leaves an untracked `alpha` directory and exits 42;
 * - `empty`: writes a valid lock that selects no skills;
 * - `invalid`: writes a version-2 lock;
 * - `bad`: writes `{bad`, which is no JSON;
 * - `missing-skill-md`: names `alpha` and `beta`, but `beta` has no SKILL.md;
 * - `no-lock`: writes no Upstream Lock at all.
 *
 * Whatever the mode, it writes `npx-state-home` in the home when it was
 * given `XDG_STATE_HOME`, which Nexus must take out of its environment.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const agents = join(home, '.agents');
const mode = process.env.NEXUS_FAKE_NPX_MODE ?? 'success';

if (process.env.XDG_STATE_HOME !== undefined) writeFileSync(join(home, 'npx-state-home'), '');

/** Write one skill directory, with a SKILL.md unless told not to. */
function skill(name: string, withSkillFile = true): void {
  mkdirSync(join(agents, 'skills', name), { recursive: true });
  if (withSkillFile) writeFileSync(join(agents, 'skills', name, 'SKILL.md'), name);
}

/** Write the Upstream Lock, one line as `printf '%s\n'` writes it. */
function lock(text: string): void {
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, '.skill-lock.json'), `${text}\n`);
}

if (mode === 'failure') {
  mkdirSync(join(agents, 'skills', 'alpha'), { recursive: true });
  writeFileSync(join(agents, 'skills', 'alpha', 'marker'), 'untracked');
  process.exitCode = 42;
} else if (mode === 'empty') {
  lock('{"version":3,"skills":{}}');
} else if (mode === 'invalid') {
  skill('alpha');
  lock('{"version":2,"skills":{"alpha":{}}}');
} else if (mode === 'bad') {
  lock('{bad');
} else if (mode === 'missing-skill-md') {
  skill('alpha');
  skill('beta', false);
  lock('{"version":3,"skills":{"alpha":{},"beta":{}}}');
} else if (mode !== 'no-lock') {
  skill('alpha');
  skill('beta');
  lock('{"version":3,"skills":{"alpha":{},"beta":{}}}');
}
