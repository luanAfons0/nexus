# Nexus Skill Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and safely bootstrap a shared skill manager that backs up Claude and Codex state, treats `~/.agents/skills` as canonical storage, and reconciles model-native skill links from an ignored Nexus lockfile.

**Architecture:** A single Bash executable owns filesystem mutations and delegates third-party installation to the upstream `skills` CLI. Three thin skills and Claude command adapters call the executable. A Bash integration suite runs every mutation under a temporary `HOME` before real bootstrap is allowed.

**Tech Stack:** Bash 5, GNU coreutils, `jq`, NVM, npm/npx, `npx skills` 1.x, Git

---

## File map

- Create `.gitignore` for machine-local lock state and temporary artifacts.
- Create `README.md` for ownership, usage, backup, recovery, and extension guidance.
- Create `scripts/nexus` for dispatch, validation, backup, canonicalization, linking, and installation.
- Create `skills/nexus-{setup,link,install}/SKILL.md` as shared model-facing skills.
- Create `skills/nexus-{setup,link,install}/claude-command.md` as Claude colon-command adapters.
- Create `tests/run.sh` as the isolated integration suite.

## Task 1: Scaffold control skills and the test harness

**Files:**

- Create: `.gitignore`
- Create: `skills/nexus-setup/SKILL.md`
- Create: `skills/nexus-setup/claude-command.md`
- Create: `skills/nexus-link/SKILL.md`
- Create: `skills/nexus-link/claude-command.md`
- Create: `skills/nexus-install/SKILL.md`
- Create: `skills/nexus-install/claude-command.md`
- Create: `tests/run.sh`

- [ ] **Step 1: Write the failing metadata test**

Create `tests/run.sh` with strict mode, a temporary root, cleanup, counters, `assert_file`, and `assert_contains`. Its first test must require `skill-lock.json` in `.gitignore`, all six model-facing files, matching `name:` fields, and an instruction to run `~/.nexus/scripts/nexus`.

```bash
#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TEST_ROOT=$(mktemp -d)
PASS=0 FAIL=0
trap 'rm -rf -- "$TEST_ROOT"' EXIT
pass() { printf 'ok - %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'not ok - %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
assert_file() { [[ -f "$1" ]] || { fail "missing file: $1"; return 1; }; }
assert_contains() { grep -Fq -- "$2" "$1" || { fail "$1 lacks: $2"; return 1; }; }
```

- [ ] **Step 2: Run the test and verify failure**

Run: `bash tests/run.sh`

Expected: nonzero exit with missing-file messages.

- [ ] **Step 3: Create metadata files**

Create `.gitignore` exactly as:

```gitignore
skill-lock.json
*.nexus-tmp.*
```

Each `SKILL.md` uses `name: nexus-setup`, `name: nexus-link`, or `name: nexus-install`. Descriptions must trigger on explicit `$nexus-*` mentions and natural language about Nexus setup, reconciliation, or installation. Bodies run only the matching `scripts/nexus` subcommand, report output, and forbid bypassing safety errors.

Each Claude adapter runs the matching subcommand. The install adapter requires a source and at least one skill, and forwards them as ordinary arguments without `eval`.

- [ ] **Step 4: Verify and commit**

Run: `bash -n tests/run.sh && bash tests/run.sh`

Expected: `1 passed, 0 failed`.

```bash
git add .gitignore skills tests/run.sh
git commit -m "feat: scaffold nexus control skills"
```

## Task 2: Implement safe bootstrap

**Files:**

- Create: `scripts/nexus`
- Modify: `tests/run.sh`

- [ ] **Step 1: Add failing bootstrap tests**

Add `new_home`, `run_nexus`, and `assert_link_to` helpers. Copy `skills/` into each fake `$HOME/.nexus`. Assert that bootstrap creates relative links for all three skills in Claude and Codex plus three Claude command links, creates no lockfile or backups, is idempotent, and preserves an unrelated physical collision while returning nonzero.

```bash
new_home() {
  local home="$TEST_ROOT/$1"
  mkdir -p "$home/.nexus"
  cp -a "$REPO_ROOT/skills" "$home/.nexus/skills"
  printf '%s\n' "$home"
}
run_nexus() {
  local home=$1; shift
  HOME="$home" NEXUS_HOME="$home/.nexus" "$REPO_ROOT/scripts/nexus" "$@"
}
assert_link_to() {
  [[ -L "$1" ]] && [[ "$(realpath -m -- "$1")" == "$2" ]]
}
```

- [ ] **Step 2: Confirm failure because the executable is missing**

Run: `bash tests/run.sh`

Expected: bootstrap cases fail because `scripts/nexus` does not exist.

- [ ] **Step 3: Implement dispatch and atomic relative links**

Create executable `scripts/nexus` with:

```bash
#!/usr/bin/env bash
set -uo pipefail
NEXUS_HOME=${NEXUS_HOME:-$HOME/.nexus}
LOCK_FILE="$NEXUS_HOME/skill-lock.json"
CANONICAL_DIR="$HOME/.agents/skills"
CLAUDE_SKILLS="$HOME/.claude/skills"
CODEX_SKILLS="$HOME/.codex/skills"
CONTROL_SKILLS=(nexus-setup nexus-link nexus-install)
ERRORS=0
info() { printf 'nexus: %s\n' "$*"; }
error() { printf 'nexus: error: %s\n' "$*" >&2; ERRORS=$((ERRORS + 1)); }
die() { printf 'nexus: error: %s\n' "$*" >&2; exit 1; }
```

Implement these exact interfaces:

- `resolved_link_target LINK`: combine `dirname`, `readlink`, and `realpath -m`.
- `is_managed_path PATH`: true only beneath canonical skills or Nexus control skills.
- `put_link TARGET LINK FORCE`: preserve unrelated entries; accept an already-correct link; create a relative `.nexus-tmp.$$.${RANDOM}` link; atomically install it with `mv -Tf`; verify its resolved target.
- `bootstrap`: link three control skills into both agent skill folders and three adapters into `~/.claude/commands/nexus`; aggregate collisions and return nonzero if any occurred.
- `main`: dispatch `bootstrap`, `setup`, `link`, and `install`; unimplemented commands fail explicitly; unknown commands return 2.

- [ ] **Step 4: Verify and commit**

Run: `bash -n scripts/nexus tests/run.sh && bash tests/run.sh`

Expected: bootstrap and collision cases pass.

```bash
git add scripts/nexus tests/run.sh
git commit -m "feat: add safe nexus bootstrap"
```

## Task 3: Implement lock validation and reconciliation

**Files:**

- Modify: `scripts/nexus`
- Modify: `tests/run.sh`

- [ ] **Step 1: Add failing link tests**

Add fixture helpers:

```bash
write_skill() {
  mkdir -p "$1"
  printf '%s\n' '---' "name: $2" 'description: fixture' '---' > "$1/SKILL.md"
}
write_lock() {
  local path=$1; shift
  mkdir -p "$(dirname "$path")"
  jq -n --argjson names "$(printf '%s\n' "$@" | jq -R . | jq -s .)" \
    '{version:3,skills:($names|map({key:.,value:{source:"test/repo",sourceType:"github",sourceUrl:"https://example.test/repo.git",skillFolderHash:"hash",installedAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"}})|from_entries)}' > "$path"
}
```

Test correct relative links, a second no-op run, explicit removal of a stale managed link, removal of a managed broken link whose lock entry lacks canonical content, missing-skill nonzero status, preservation of unrelated files/directories/external links, and preservation of Codex `.system`.

Add invalid-lock cases for malformed JSON, version other than 3, non-object `skills`, empty names, `.`, `..`, and names containing `/`. Snapshot both agent trees and assert invalid locks cause no mutations.

- [ ] **Step 2: Confirm the link tests fail**

Run: `bash tests/run.sh`

Expected: link cases fail with the explicit unimplemented message.

- [ ] **Step 3: Implement lock validation**

Add:

```bash
validate_lock() {
  local file=$1
  [[ -f "$file" ]] || { error "lockfile not found: $file"; return 1; }
  jq -e 'type=="object" and .version==3 and (.skills|type=="object") and
    ([.skills|keys[]|test("^[A-Za-z0-9][A-Za-z0-9._-]*$") and .!="." and .!=".."]|all)' \
    "$file" >/dev/null 2>&1 || { error "invalid version-3 lockfile: $file"; return 1; }
}
```

Add `desired_names`, `skill_target`, and `is_desired_name`. Desired entries are the lock keys plus the three controls. Third-party targets are canonical; controls target Nexus.

- [ ] **Step 4: Implement reconciliation**

Add `remove_stale_links DIR` and `link_all FORCE` with these rules:

- Scan only direct symlink children.
- Never treat `.system` as managed.
- Remove a stale child only if its lexical/resolved target is managed.
- For a desired skill missing `SKILL.md`, remove managed agent links for that name, report the missing canonical path, and continue.
- Call `put_link` for valid desired entries.
- Aggregate all errors and return nonzero after processing every entry.

Wire `main link` to reject arguments and call `link_all false`.

- [ ] **Step 5: Verify and commit**

Run: `bash -n scripts/nexus tests/run.sh && bash tests/run.sh`

Expected: all invalid-lock, stale-link, missing-skill, collision, `.system`, and idempotency tests pass.

```bash
git add scripts/nexus tests/run.sh
git commit -m "feat: reconcile nexus-managed skill links"
```

## Task 4: Implement guarded setup and canonicalization

**Files:**

- Modify: `scripts/nexus`
- Modify: `tests/run.sh`

- [ ] **Step 1: Add failing setup tests**

Construct agent trees containing hidden files, executable files, ordinary symlinks, Codex `.system`, and a canonical skill symlinked back into Claude. Assert setup:

- Copies complete `~/.claude-backup` and `~/.codex-backup` trees.
- Leaves live agent roots in place.
- Publishes an identical Nexus lockfile only after backups exist.
- Converts the managed canonical symlink into a physical directory containing `SKILL.md`.
- Replaces the backed-up agent collision with canonical links without creating a cycle.
- Disables a second setup and prints `already initialized` plus link guidance.

Add independent cases for an existing backup, absent agent directories, identical candidate locks, conflicting candidate locks, and a deterministic backup-copy failure through `NEXUS_CP`.

- [ ] **Step 2: Confirm setup tests fail**

Run: `bash tests/run.sh`

Expected: setup cases fail with the explicit unimplemented message.

- [ ] **Step 3: Implement lock discovery and publication**

Implement `discover_lock` using this ordered candidate list:

```bash
"$HOME/.agents/.skill-lock.json"
"$HOME/.agents/skill-lock.json"
"$HOME/.skills/.skill-lock.json"
"$HOME/.skills/skill-lock.json"
```

Validate all found files. Compare `jq -S -c .` output so formatting-only differences are accepted. Return the first candidate when all are identical; reject differing content.

Implement `atomic_copy SOURCE DESTINATION` using a sibling `.nexus-tmp.$$.${RANDOM}`, `cp -a`, and `mv -Tf`.

- [ ] **Step 4: Implement backup and canonicalization**

Implement:

```bash
backup_agent_dir() {
  local source=$1 destination=$2 tmp="$destination.nexus-tmp.$$"
  [[ ! -e "$destination" && ! -L "$destination" ]] || return 1
  mkdir -p -- "$tmp"
  if [[ -d "$source" ]]; then "${NEXUS_CP:-cp}" -a -- "$source/." "$tmp/" || return 1; fi
  mv -- "$tmp" "$destination"
}
```

Implement `materialize_canonical_links` by iterating lock keys. For each canonical symlink: resolve it; require target `SKILL.md`; copy dereferenced contents using `cp -aL` into a verified sibling temp directory; rename the old symlink aside; promote the physical temp; remove only the old symlink after success; restore it if promotion fails. Leave physical and untracked canonical entries unchanged.

- [ ] **Step 5: Implement setup order and recovery output**

Setup order is fixed:

1. If the Nexus lock exists, print link guidance and return success without mutation.
2. Verify `jq`, `cp`, `mv`, `realpath`, and both final backup paths.
3. Discover and validate the source lock.
4. Copy both agent roots to temporary backups and promote both.
5. Atomically publish the Nexus lock.
6. Materialize lock-managed canonical symlinks.
7. Run `link_all true` so backed-up desired collisions can be replaced.
8. Print source lock, backup paths, linked count, and missing skills.

An `EXIT` trap may remove only setup-owned temporary paths. If a post-publication operation fails, retain final backups and lockfile, return nonzero, and tell the user to correct the reported issue and run link.

- [ ] **Step 6: Verify and commit**

Run: `bash -n scripts/nexus tests/run.sh && bash tests/run.sh`

Expected: all setup and regression tests pass; the canonicalized fixture is physical and no symlink cycle exists.

```bash
git add scripts/nexus tests/run.sh
git commit -m "feat: add guarded nexus setup migration"
```

## Task 5: Implement installation and NVM fallback

**Files:**

- Modify: `scripts/nexus`
- Modify: `tests/run.sh`

- [ ] **Step 1: Add failing fake-npx tests**

Create a fake `npx` that records every argument on its own line. Success mode creates canonical `SKILL.md` files and writes `~/.agents/.skill-lock.json`; failure mode creates an untracked directory and exits 42.

Assert the success command receives distinct arguments equivalent to:

```text
npx --yes skills add SOURCE --global --agent universal --skill NAME [--skill NAME] --yes
```

Assert success atomically updates Nexus and links both agents. Assert failure preserves the Nexus lock byte-for-byte and reports the untracked directory.

Add a reduced-PATH test with `$HOME/.nvm/nvm.sh` defining `nvm use default` to prepend a fake-npx directory.

- [ ] **Step 2: Confirm installation tests fail**

Run: `bash tests/run.sh`

Expected: install cases fail with the explicit unimplemented message.

- [ ] **Step 3: Implement parsing and NVM loading**

Implement `parse_install_args` to require one source, accept only repeated `--skill NAME`, reject unknown flags, and require at least one skill.

Implement:

```bash
ensure_npx() {
  command -v npx >/dev/null 2>&1 && return 0
  local nvm_dir=${NVM_DIR:-$HOME/.nvm}
  [[ -s "$nvm_dir/nvm.sh" ]] || { error 'npx is unavailable and NVM was not found'; return 1; }
  set +u
  . "$nvm_dir/nvm.sh"
  nvm use default >/dev/null
  set -u
  command -v npx >/dev/null 2>&1 || { error 'NVM loaded but npx is unavailable'; return 1; }
}
```

- [ ] **Step 4: Implement install and publication**

Build the upstream command only as a Bash array. Invoke it with `env -u XDG_STATE_HOME` so upstream state remains at `~/.agents/.skill-lock.json`. On success:

1. Validate the upstream version-3 lock.
2. Require `SKILL.md` for every upstream lock key.
3. Atomically copy upstream lock to Nexus.
4. Run `link_all false`.
5. Print canonical and agent paths for selected skills.

On failure, never modify the Nexus lock. Report selected canonical directories that now exist as untracked. Do not remove them automatically.

- [ ] **Step 5: Verify and commit**

Run: `bash -n scripts/nexus tests/run.sh && bash tests/run.sh`

Expected: argument capture, success, failure preservation, and reduced-PATH NVM tests pass with all regressions.

```bash
git add scripts/nexus tests/run.sh
git commit -m "feat: install skills through upstream cli"
```

## Task 6: Document and safely bootstrap the real agents

**Files:**

- Create: `README.md`
- Modify: `tests/run.sh`

- [ ] **Step 1: Add failing README assertions**

Require these literal topics: `~/.agents/skills`, `skill-lock.json`, `.claude-backup`, `.codex-backup`, `/nexus:setup`, `$nexus-setup`, `npx skills`, `recovery`, and `another agent`.

- [ ] **Step 2: Confirm README test failure**

Run: `bash tests/run.sh`

Expected: one metadata failure naming `README.md`.

- [ ] **Step 3: Write README**

Document:

- Why Nexus exists and the four ownership locations.
- Bash/coreutils/jq/Git/NVM/npm/npx prerequisites.
- `~/.nexus/scripts/nexus bootstrap` first use.
- Native Claude and Codex invocation forms.
- Setup backup guarantees, disablement, lock discovery, and canonicalization.
- Link repair/removal rules and collision safety.
- Install examples for Git shorthand, Git URLs, and local directories.
- The upstream versus authoritative lock relationship.
- Manual, selective recovery from backups.
- Troubleshooting for locks, missing skills, collisions, NVM, and upstream failure.
- The code/test changes required to add another agent.

- [ ] **Step 4: Run final isolated checks**

```bash
bash -n scripts/nexus tests/run.sh
bash tests/run.sh
git diff --check
```

Expected: syntax succeeds, every test reports `ok`, zero failures, and no whitespace errors.

- [ ] **Step 5: Inspect real bootstrap targets read-only**

Inspect these nine exact paths with `test`, `readlink`, and `realpath`: three Claude skill paths, three Codex skill paths, and three `~/.claude/commands/nexus/*.md` paths. If any is an unrelated entry, stop and report it.

- [ ] **Step 6: Run only real bootstrap**

Run: `~/.nexus/scripts/nexus bootstrap`

Expected: control skills and adapters are linked. Do not run real setup during implementation; its large backups remain an explicit user action through a newly exposed skill.

- [ ] **Step 7: Verify real links read-only**

For every control skill, assert both agent paths resolve to `~/.nexus/skills/<name>` and contain `SKILL.md`. Assert each Claude command resolves to the corresponding `claude-command.md`.

- [ ] **Step 8: Commit documentation**

```bash
git add README.md tests/run.sh
git commit -m "docs: explain nexus setup and recovery"
git status --short --branch
```

Expected: a clean implementation branch.

## Final acceptance checklist

- [ ] `skill-lock.json` is ignored and absent from Git history.
- [ ] All mutation tests ran under temporary homes.
- [ ] Setup never overwrites backups and disables itself after publication.
- [ ] Managed canonical symlinks are materialized before agent collisions change.
- [ ] Link removes stale/broken managed links without deleting physical skills.
- [ ] Codex `.system` and unrelated entries are preserved.
- [ ] Install uses argument arrays, upstream `npx skills`, and NVM fallback.
- [ ] Failed installs preserve Nexus state.
- [ ] Real bootstrap creates only the nine reviewed control entries.
- [ ] Real setup is not run implicitly during implementation.
