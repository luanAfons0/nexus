/**
 * Seam 3, for Link, the lock and Install: named fault points, driven
 * through the CLI as a subprocess (Seam 1).
 *
 * These are the fault cases of `tests/run.sh` that `tests/faults.sh` made
 * with Bash function overrides: `bootstrap_staging_failure`,
 * `force_recovery`, `link_snapshot_safety` and the two install cases of
 * `install_cli_and_nvm_fallback`, each asserting what the Bash case asserted.
 * The Bash CLI drove a forced link by calling `put_link` itself; the port has
 * no such entry, so a forced link here is the one Setup makes over a Foreign
 * Entry at a Control Skill's path. Setup's own fault cases are in
 * `setup-faults.test.ts`, and the cases that interrupt Setup in
 * `interruption.test.ts`.
 *
 * On Windows a home's links are junctions, as `makeLink` makes them.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { snapshotTree, writeLock, writeSkill } from './helpers/homes.ts';
import { assertFaultSameAsBash } from './helpers/faults.ts';
import { assertLinkTo, isAbsent, linkText, makeLink, WINDOWS } from './helpers/links.ts';
import { installFake, newHome, type RunOptions, runNexus } from './helpers/nexus.ts';

/** Run the CLI in `home` with the fault point `fault`. */
function runFault(home: string, fault: string, args: readonly string[], options: RunOptions = {}) {
  return runNexus(home, args, { ...options, env: { ...options.env, NEXUS_FAULT: fault } });
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The entries of `dir` whose names start with `prefix`. */
function named(dir: string, prefix: string): readonly string[] {
  try {
    return readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
}

/** Both Native Skill Roots, as one snapshot. */
function agentSkills(home: string): string {
  return [...snapshotTree(join(home, '.claude')), '|', ...snapshotTree(join(home, '.codex'))].join(
    '\n',
  );
}

/**
 * The home of `link_snapshot_safety`: `alpha` in the lock, and `stale`
 * linked in both agents though the lock no longer names it.
 */
function snapshotHome(name: string): string {
  const home = newHome(name);
  fillSnapshotHome(home);
  return home;
}

function fillSnapshotHome(home: string): void {
  const canonical = join(home, '.agents', 'skills');
  writeSkill(canonical, 'alpha');
  writeSkill(canonical, 'stale');
  writeLock(join(home, '.nexus', 'skill-lock.json'), ['alpha']);
  for (const agent of ['.claude', '.codex']) {
    mkdirSync(join(home, agent, 'skills'), { recursive: true });
    makeLink('../../.agents/skills/stale', join(home, agent, 'skills', 'stale'));
  }
}

/** A home whose `.claude/skills/nexus-setup` is a directory Setup must replace. */
function forcedHome(name: string, marker: string): string {
  const home = newHome(name);
  fillForcedHome(home, marker);
  return home;
}

function fillForcedHome(home: string, marker: string): void {
  writeLock(join(home, '.agents', '.skill-lock.json'), []);
  write(join(home, '.claude', 'skills', 'nexus-setup', 'marker'), `${marker}\n`);
}

test('NEXUS_FAULT changes nothing without NEXUS_TEST_MODE=1 or the test-home marker', () => {
  const home = snapshotHome('fault_ignored');
  const faulted = runFault(home, 'lock_extract', ['link']);
  assert.notEqual(faulted.status, 0);
  assert.match(faulted.stderr, /test seam: lock key extraction failed/);

  for (const options of [{ testMode: false }, { unmarked: true }] as const) {
    const run = runFault(home, 'lock_extract', ['link'], options);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout + run.stderr, /test seam/);
  }
  assertLinkTo(join(home, '.claude', 'skills', 'alpha'), join(home, '.agents', 'skills', 'alpha'));
});

test('a staged link that cannot be put in place leaves the existing link as it was', () => {
  const home = newHome('staging_failure');
  assert.equal(runNexus(home, ['bootstrap']).status, 0);
  const link = join(home, '.claude', 'skills', 'nexus-setup');
  unlinkSync(link);
  makeLink(join(home, '.nexus', 'skills', 'nexus-link'), link);
  const old = linkText(link);
  const run = runFault(home, 'stage', ['bootstrap']);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /staged link creation failed/);
  assert.equal(linkText(link), old);
});

test('a forced link that cannot be promoted puts the Foreign Entry back and leaves no temp', () => {
  const home = forcedHome('force_promotion_failure', 'restore-me');
  const run = runFault(home, 'promote', ['setup']);
  assert.notEqual(run.status, 0);
  const skills = join(home, '.claude', 'skills');
  assert.equal(readFileSync(join(skills, 'nexus-setup', 'marker'), 'utf8'), 'restore-me\n');
  assert.deepEqual(named(skills, '.nexus-backup.'), []);
  assert.deepEqual(named(skills, '.nexus-tmp.'), []);
});

test('a forced link that cannot be verified moves nothing and leaves no temp', () => {
  const home = forcedHome('force_verify_failure', 'verify-me');
  const run = runFault(home, 'verify', ['setup']);
  assert.notEqual(run.status, 0);
  const skills = join(home, '.claude', 'skills');
  assert.equal(readFileSync(join(skills, 'nexus-setup', 'marker'), 'utf8'), 'verify-me\n');
  assert.deepEqual(named(skills, '.nexus-backup.'), []);
  assert.deepEqual(named(skills, '.nexus-tmp.'), []);
});

test('a Foreign Entry that cannot be put back stays in its named recovery container', () => {
  const home = forcedHome('force_restore_failure', 'retain-me');
  const run = runFault(home, 'restore', ['setup']);
  assert.notEqual(run.status, 0);
  const containers = [...run.stderr.matchAll(/recovery container retained: (.*)/g)];
  const container = containers.at(-1)?.[1];
  assert.ok(container !== undefined, run.stderr);
  assert.equal(readFileSync(join(container, 'original', 'marker'), 'utf8'), 'retain-me\n');
});

test('a lock whose keys cannot be read changes no Agent Home and leaves no Snapshot', () => {
  const home = snapshotHome('link_snapshot_extract');
  const before = agentSkills(home);
  const run = runFault(home, 'lock_extract', ['link']);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /lock key extraction failed/);
  assert.equal(agentSkills(home), before);
  assert.deepEqual(named(join(home, '.nexus'), '.nexus-lock.'), []);
});

test('a lock replaced after it was read changes nothing Link does with it', () => {
  const home = snapshotHome('link_snapshot_replace');
  const run = runFault(home, 'lock_replace', ['link']);
  assert.equal(run.status, 0, run.stderr);
  const canonical = join(home, '.agents', 'skills');
  assertLinkTo(join(home, '.claude', 'skills', 'alpha'), join(canonical, 'alpha'));
  assertLinkTo(join(home, '.codex', 'skills', 'alpha'), join(canonical, 'alpha'));
  assert.equal(linkText(join(home, '.claude', 'skills', 'stale')), undefined);
  assert.equal(linkText(join(home, '.codex', 'skills', 'stale')), undefined);
  for (const dir of ['.claude', '.codex', '.agents']) assert.ok(isAbsent(join(home, dir, 'escape')));
  assert.deepEqual(named(join(home, '.nexus'), '.nexus-lock.'), []);
  // The fault point did replace the lock: Link had read it once, before.
  assert.match(readFileSync(join(home, '.nexus', 'skill-lock.json'), 'utf8'), /escape/);
});

test('install Publishes the Snapshot it validated, not the Upstream Lock changed since', () => {
  const home = newHome('install_snapshot');
  writeSkill(join(home, '.agents', 'skills'), 'alpha');
  writeSkill(join(home, '.agents', 'skills'), 'beta');
  installFake(home, 'npx', 'npx-install.ts');
  const run = runFault(home, 'install_snapshot_mutate', ['install', 'source', '--skill', 'alpha'], {
    env: { NEXUS_FAKE_NPX_MODE: 'alpha' },
  });
  assert.equal(run.status, 0, run.stderr);
  const published = readFileSync(join(home, '.nexus', 'skill-lock.json'), 'utf8');
  assert.equal(published, '{"version":3,"skills":{"alpha":{}}}\n');
  const upstream = join(home, '.agents', '.skill-lock.json');
  assert.ok(isAbsent(upstream) || readFileSync(upstream, 'utf8').includes('beta'));
  assert.deepEqual(named(join(home, '.nexus'), '.nexus-install-'), []);
});

test('install scratch that cannot be removed is named and kept', () => {
  const home = newHome('install_cleanup');
  installFake(home, 'npx', 'npx-install.ts');
  const run = runFault(home, 'install_cleanup_fail', ['install', 'source', '--skill', 'alpha'], {
    env: { NEXUS_FAKE_NPX_MODE: 'bad' },
  });
  assert.match(run.stderr, /install scratch retained: /);
  assert.notDeepEqual(named(join(home, '.nexus'), '.nexus-install-'), []);
});

test('every Link and lock fault says the same bytes and leaves the same trees as the Bash CLI', { skip: WINDOWS && 'the Bash CLI runs on Linux alone' }, () => {
  assertFaultSameAsBash('lock_extract', ['link'], fillSnapshotHome);
  assertFaultSameAsBash('lock_replace', ['link'], fillSnapshotHome);
  for (const fault of ['stage', 'promote', 'verify', 'restore']) {
    assertFaultSameAsBash(fault, ['setup'], (home) => fillForcedHome(home, fault));
  }
});
