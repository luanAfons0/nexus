#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)" || exit 1
if [[ -z "$TEST_ROOT" || ! -d "$TEST_ROOT" ]]; then
  printf 'FAIL: could not create a valid temporary test directory\n' >&2
  exit 1
fi
PASS=0
FAIL=0

cleanup() {
  if [[ -n "$TEST_ROOT" && -d "$TEST_ROOT" ]]; then
    rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT

pass() {
  PASS=$((PASS + 1))
  printf 'PASS: %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL: %s\n' "$1" >&2
}

assert_file() {
  local path="$1"
  if [[ -f "$REPO_ROOT/$path" ]]; then
    return 0
  else
    printf '  missing file: %s\n' "$path" >&2
    return 1
  fi
}

assert_contains() {
  local path="$1"
  local expected="$2"
  if [[ -f "$REPO_ROOT/$path" ]] && grep -Fq -- "$expected" "$REPO_ROOT/$path"; then
    return 0
  else
    printf '  missing text in %s: %s\n' "$path" "$expected" >&2
    return 1
  fi
}

assert_line() {
  local path="$1"
  local expected="$2"
  if [[ -f "$REPO_ROOT/$path" ]] && grep -Fxq -- "$expected" "$REPO_ROOT/$path"; then
    return 0
  else
    printf '  missing exact line in %s: %s\n' "$path" "$expected" >&2
    return 1
  fi
}

new_home() {
  local name="$1" home="$TEST_ROOT/$1"
  mkdir -p "$home/.nexus"
  cp -R -- "$REPO_ROOT/skills" "$home/.nexus/"
  printf '%s\n' "$home"
}

run_nexus() {
  local home="$1"
  shift
  HOME="$home" NEXUS_HOME="$home/.nexus" "$REPO_ROOT/scripts/nexus" "$@"
}

run_put_link_force() {
  local home="$1" target="$2" link="$3"
  HOME="$home" NEXUS_HOME="$home/.nexus" bash -c \
    'source "$1"; put_link "$2" "$3" true' bash "$REPO_ROOT/scripts/nexus" "$target" "$link"
}

assert_link_to() {
  local link="$1" expected="$2" actual
  if [[ ! -L "$link" ]]; then
    printf '  not a symlink: %s\n' "$link" >&2
    return 1
  fi
  actual="$(realpath -m -- "$link")"
  expected="$(realpath -m -- "$expected")"
  if [[ "$actual" == "$expected" ]]; then
    return 0
  fi
  printf '  wrong target for %s: %s (expected %s)\n' "$link" "$actual" "$expected" >&2
  return 1
}

write_skill() {
  local dir="$1" name="$2"
  mkdir -p -- "$dir/$name"
  printf '%s\n' "---" "name: $name" "---" >"$dir/$name/SKILL.md"
}

write_lock() {
  local path="$1"
  shift
  mkdir -p -- "$(dirname -- "$path")"
  jq -n '
    {
      version: 3,
      source: "test",
      sourceType: "local",
      sourceUrl: "https://example.invalid/skills",
      skillFolderHash: "test-hash",
      installedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      skills: (reduce $ARGS.positional[] as $name ({};
        .[$name] = {
          source: "test",
          sourceType: "local",
          sourceUrl: "https://example.invalid/skills",
          skillFolderHash: "test-hash",
          installedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z"
        }))
    }' --args "$@" >"$path"
}

snapshot_tree() {
  local root="$1"
  if [[ -d "$root" ]]; then
    find "$root" -mindepth 1 -printf '%y|%P|%l\n' | LC_ALL=C sort
  fi
}

test_bootstrap() {
  local failed=0 home output before after name command link target
  home="$(new_home bootstrap)"
  output="$(run_nexus "$home" bootstrap 2>&1)" || { printf '%s\n' "$output" >&2; failed=1; }

  for name in nexus-setup nexus-link nexus-install; do
    link="$home/.claude/skills/$name"; target="$home/.nexus/skills/$name"
    assert_link_to "$link" "$target" || failed=1
    [[ "$(readlink -- "$link")" != /* ]] || { printf '  absolute Claude link: %s\n' "$link" >&2; failed=1; }
    link="$home/.codex/skills/$name"
    assert_link_to "$link" "$target" || failed=1
    [[ "$(readlink -- "$link")" != /* ]] || { printf '  absolute Codex link: %s\n' "$link" >&2; failed=1; }
    command="${name#nexus-}.md"
    link="$home/.claude/commands/nexus/$command"; target="$home/.nexus/skills/$name/claude-command.md"
    assert_link_to "$link" "$target" || failed=1
    [[ "$(readlink -- "$link")" != /* ]] || { printf '  absolute adapter link: %s\n' "$link" >&2; failed=1; }
  done
  [[ ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  [[ ! -e "$home/.claude-backup" ]] || failed=1
  [[ ! -e "$home/.codex-backup" ]] || failed=1

  before="$(find "$home/.claude" "$home/.codex" -type l -print -exec readlink -- {} \; | sort)"
  run_nexus "$home" bootstrap >/dev/null 2>&1 || failed=1
  after="$(find "$home/.claude" "$home/.codex" -type l -print -exec readlink -- {} \; | sort)"
  [[ "$before" == "$after" ]] || { printf '  second run changed links\n' >&2; failed=1; }
  if (( failed == 0 )); then pass bootstrap; else fail bootstrap; fi
}

test_bootstrap_collision() {
  local failed=0 home output
  home="$(new_home collision)"
  mkdir -p "$home/.claude/skills/nexus-setup"
  printf 'preserve\n' >"$home/.claude/skills/nexus-setup/marker"
  mkdir -p "$home/.codex/skills"
  ln -s /external/target "$home/.codex/skills/nexus-link"
  output="$(run_nexus "$home" bootstrap 2>&1)" && failed=1
  [[ "$output" == *collision* ]] || { printf '  collision not reported\n%s\n' "$output" >&2; failed=1; }
  [[ -f "$home/.claude/skills/nexus-setup/marker" ]] || failed=1
  [[ "$(readlink -- "$home/.codex/skills/nexus-link")" == /external/target ]] || failed=1
  assert_link_to "$home/.claude/skills/nexus-link" "$home/.nexus/skills/nexus-link" || failed=1
  assert_link_to "$home/.codex/skills/nexus-setup" "$home/.nexus/skills/nexus-setup" || failed=1
  if (( failed == 0 )); then pass bootstrap_collision; else fail bootstrap_collision; fi
}

test_bootstrap_staging_failure() {
  local failed=0 home old output link
  home="$(new_home staging_failure)"
  run_nexus "$home" bootstrap >/dev/null 2>&1 || failed=1
  link="$home/.claude/skills/nexus-setup"
  ln -sfn -- "$home/.nexus/skills/nexus-link" "$link"
  old="$(readlink -- "$link")"
  output="$(NEXUS_TEST_FAIL=stage HOME="$home" NEXUS_HOME="$home/.nexus" "$REPO_ROOT/scripts/nexus" bootstrap 2>&1)" && failed=1
  [[ "$output" == *'staged link creation failed'* ]] || failed=1
  [[ "$(readlink -- "$link")" == "$old" ]] || { printf '  staging failure changed existing link\n' >&2; failed=1; }
  if (( failed == 0 )); then pass bootstrap_staging_failure; else fail bootstrap_staging_failure; fi
}

test_bootstrap_lexical_managed_link() {
  local failed=0 home bridge link
  home="$(new_home lexical_managed)"
  bridge="$home/.nexus/skills/alias"
  ln -s /external/target "$bridge"
  link="$home/.claude/skills/nexus-setup"
  mkdir -p "$(dirname -- "$link")"
  ln -s -- "../../.nexus/skills/alias/nexus-setup" "$link"
  run_nexus "$home" bootstrap >/dev/null 2>&1 || failed=1
  assert_link_to "$link" "$home/.nexus/skills/nexus-setup" || failed=1
  [[ "$(readlink -- "$link")" != '../../.nexus/skills/alias/nexus-setup' ]] || failed=1
  if (( failed == 0 )); then pass bootstrap_lexical_managed_link; else fail bootstrap_lexical_managed_link; fi
}

test_bootstrap_symlinked_managed_root() {
  local failed=0 home link
  home="$(new_home symlinked_root)"
  mv -- "$home/.nexus/skills" "$home/.nexus/skills-real"
  ln -s -- skills-real "$home/.nexus/skills"
  link="$home/.claude/skills/nexus-setup"
  mkdir -p "$(dirname -- "$link")"
  ln -s -- "$home/.nexus/skills-real/nexus-link" "$link"
  run_nexus "$home" bootstrap >/dev/null 2>&1 || failed=1
  assert_link_to "$link" "$home/.nexus/skills/nexus-setup" || failed=1
  if (( failed == 0 )); then pass bootstrap_symlinked_managed_root; else fail bootstrap_symlinked_managed_root; fi
}

test_force_replacement() {
  local failed=0 home filehome output marker parent
  home="$(new_home force_directory)"
  parent="$home/.claude/skills"
  mkdir -p "$parent/nexus-setup"
  printf 'directory-marker\n' >"$parent/nexus-setup/marker"
  mkdir -p "$parent/.nexus-backup.fixed"
  printf 'sibling-marker\n' >"$parent/.nexus-backup.fixed/marker"
  output="$(run_put_link_force "$home" "$home/.nexus/skills/nexus-setup" "$parent/nexus-setup" 2>&1)" || failed=1
  assert_link_to "$parent/nexus-setup" "$home/.nexus/skills/nexus-setup" || failed=1
  [[ "$(cat "$parent/.nexus-backup.fixed/marker")" == sibling-marker ]] || failed=1
  [[ -d "$parent/.nexus-backup.fixed" ]] || failed=1
  [[ -z "$(find "$parent" -maxdepth 1 -type d -name '.nexus-backup.*' ! -name '.nexus-backup.fixed' -print -quit)" ]] || failed=1

  filehome="$(new_home force_file)"
  mkdir -p "$filehome/.claude/skills"
  printf 'file-marker\n' >"$filehome/.claude/skills/nexus-setup"
  output="$(run_put_link_force "$filehome" "$filehome/.nexus/skills/nexus-setup" "$filehome/.claude/skills/nexus-setup" 2>&1)" || failed=1
  assert_link_to "$filehome/.claude/skills/nexus-setup" "$filehome/.nexus/skills/nexus-setup" || failed=1
  if (( failed == 0 )); then pass force_replacement; else fail force_replacement; fi
}

test_force_recovery() {
  local failed=0 home output marker link backup
  home="$(new_home force_promotion_failure)"
  link="$home/.claude/skills/nexus-setup"
  mkdir -p "$link"
  printf 'restore-me\n' >"$link/marker"
  output="$(NEXUS_TEST_FAIL=promote run_put_link_force "$home" "$home/.nexus/skills/nexus-setup" "$link" 2>&1)" && failed=1
  [[ -f "$link/marker" && "$(cat "$link/marker")" == restore-me ]] || failed=1
  [[ -z "$(find "$home/.claude/skills" -maxdepth 1 -type d -name '.nexus-backup.*' -print -quit)" ]] || failed=1
  [[ -z "$(find "$home/.claude/skills" -maxdepth 1 -name '.nexus-tmp.*' -print -quit)" ]] || failed=1

  home="$(new_home force_verify_failure)"
  link="$home/.claude/skills/nexus-setup"
  mkdir -p "$link"
  printf 'verify-me\n' >"$link/marker"
  output="$(NEXUS_TEST_FAIL=verify run_put_link_force "$home" "$home/.nexus/skills/nexus-setup" "$link" 2>&1)" && failed=1
  [[ -f "$link/marker" && "$(cat "$link/marker")" == verify-me ]] || failed=1
  [[ -z "$(find "$home/.claude/skills" -maxdepth 1 \( -name '.nexus-tmp.*' -o -name '.nexus-backup.*' \) -print -quit)" ]] || failed=1

  home="$(new_home force_restore_failure)"
  link="$home/.claude/skills/nexus-setup"
  mkdir -p "$link"
  printf 'retain-me\n' >"$link/marker"
  output="$(NEXUS_TEST_FAIL=restore run_put_link_force "$home" "$home/.nexus/skills/nexus-setup" "$link" 2>&1)" && failed=1
  backup="$(printf '%s\n' "$output" | sed -n 's/.*recovery container retained: //p' | tail -n 1)"
  [[ -n "$backup" && -f "$backup/original/marker" ]] || failed=1
  [[ "$(cat "$backup/original/marker" 2>/dev/null)" == retain-me ]] || failed=1
  if (( failed == 0 )); then pass force_recovery; else fail force_recovery; fi
}

test_dispatcher() {
  local failed=0 home output status command
  home="$(new_home dispatcher)"
  output="$(run_nexus "$home" 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || failed=1
  output="$(run_nexus "$home" nope 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || failed=1
  output="$(run_nexus "$home" help)"; status=$?
  [[ "$status" -eq 0 && "$output" == *'Usage:'* ]] || failed=1
  output="$(HOME="$home" NEXUS_HOME="$home/.nexus" bash -c 'source "$1"' bash "$REPO_ROOT/scripts/nexus")"; status=$?
  [[ "$status" -eq 0 && -z "$output" ]] || failed=1
  output="$(run_nexus "$home" bootstrap extra 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || failed=1
  output="$(run_nexus "$home" setup 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'no version-3 skill lock found'* ]] || failed=1
  output="$(run_nexus "$home" setup extra 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || failed=1
  output="$(run_nexus "$home" install 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'not implemented yet'* ]] || failed=1
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'invalid version-3 lock'* ]] || failed=1
  output="$(run_nexus "$home" link extra 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || failed=1
  if (( failed == 0 )); then pass dispatcher; else fail dispatcher; fi
}

test_force_env_does_not_bypass_bootstrap() {
  local failed=0 home output
  home="$(new_home force_env_ignored)"
  mkdir -p "$home/.claude/skills/nexus-setup"
  printf 'protected\n' >"$home/.claude/skills/nexus-setup/marker"
  output="$(NEXUS_TEST_FORCE=true run_nexus "$home" bootstrap 2>&1)" && failed=1
  [[ "$output" == *collision* ]] || failed=1
  [[ -f "$home/.claude/skills/nexus-setup/marker" ]] || failed=1
  if (( failed == 0 )); then pass force_env_ignored; else fail force_env_ignored; fi
}

test_link_invalid_locks_do_not_mutate() {
  local failed=0 home lock case output status before after bad_name
  home="$(new_home link_invalid_locks)"
  lock="$home/.nexus/skill-lock.json"
  mkdir -p "$home/.claude/skills" "$home/.codex/skills"
  ln -s -- "../../.nexus/skills/nexus-setup" "$home/.claude/skills/existing"
  ln -s -- "../../.nexus/skills/nexus-link" "$home/.codex/skills/existing"

  for case in missing malformed version skills_object invalid_then_valid valid_then_another '' '.' '..' 'bad/name' '../escape' '-bad' '_bad' $'line\nbreak' $'tab\tkey' $'trailing\n'; do
    rm -f -- "$lock"
    case "$case" in
      missing) ;;
      malformed) printf '%s\n' '{not json' >"$lock" ;;
      version) jq -n '{version: 2, skills: {alpha: {}}}' >"$lock" ;;
      skills_object) jq -n '{version: 3, skills: []}' >"$lock" ;;
      invalid_then_valid)
        printf '%s\n%s\n' '{"version": 2, "skills": {}}' '{"version": 3, "skills": {}}' >"$lock"
        ;;
      valid_then_another)
        printf '%s\n%s\n' '{"version": 3, "skills": {}}' '{"version": 3, "skills": {"alpha": {}}}' >"$lock"
        ;;
      *)
        bad_name="$case"
        jq -n --arg name "$bad_name" '{version: 3, skills: {($name): {}}}' >"$lock"
        ;;
    esac
    before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
    output="$(run_nexus "$home" link 2>&1)"; status=$?
    after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
    [[ "$status" -ne 0 && "$output" == *'invalid version-3 lock'* ]] || {
      printf '  invalid lock case did not fail clearly: %q\n%s\n' "$case" "$output" >&2
      failed=1
    }
    [[ "$before" == "$after" ]] || {
      printf '  invalid lock case mutated agent trees: %q\n' "$case" >&2
      failed=1
    }
  done
  if (( failed == 0 )); then pass link_invalid_locks_do_not_mutate; else fail link_invalid_locks_do_not_mutate; fi
}

test_link_reconciliation() {
  local failed=0 home canonical lock output status before after stale_before stale_after
  home="$(new_home link_reconciliation)"
  canonical="$home/.agents/skills"
  lock="$home/.nexus/skill-lock.json"
  write_skill "$canonical" alpha
  write_skill "$canonical" beta
  write_skill "$canonical" stale
  printf 'stale-marker\n' >"$canonical/stale/marker"
  stale_before="$(sha256sum "$canonical/stale/SKILL.md" "$canonical/stale/marker")"
  write_lock "$lock" alpha beta missing
  mkdir -p "$home/.claude/skills" "$home/.codex/skills/.system"
  printf 'keep\n' >"$home/.codex/skills/.system/marker"
  ln -s -- "../../.agents/skills/beta" "$home/.claude/skills/alpha"
  ln -s -- "../../.agents/skills/stale" "$home/.claude/skills/stale"
  ln -s -- "../../.agents/skills/stale" "$home/.codex/skills/stale"
  ln -s -- "../../.agents/skills/missing" "$home/.claude/skills/missing"
  ln -s -- "../../.agents/skills/missing" "$home/.codex/skills/missing"
  mkdir -p "$home/.agents/skills-elsewhere"
  ln -s -- "../../.agents/skills-elsewhere/keep" "$home/.claude/skills/prefix-lookalike"
  ln -s -- /external/keep "$home/.codex/skills/external-link"
  printf 'physical\n' >"$home/.claude/skills/unrelated-file"
  mkdir -p "$home/.codex/skills/unrelated-dir"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -ne 0 && "$output" == *'missing skill: missing'* ]] || {
    printf '  missing skill was not reported after reconciliation\n%s\n' "$output" >&2; failed=1;
  }
  [[ "$output" != *prefix-lookalike* && "$output" != *external-link* && "$output" != *unrelated-file* && "$output" != *unrelated-dir* ]] || failed=1
  for name in alpha beta nexus-setup nexus-link nexus-install; do
    if [[ "$name" == nexus-* ]]; then
      assert_link_to "$home/.claude/skills/$name" "$home/.nexus/skills/$name" || failed=1
      assert_link_to "$home/.codex/skills/$name" "$home/.nexus/skills/$name" || failed=1
    else
      assert_link_to "$home/.claude/skills/$name" "${canonical}/$name" || failed=1
      assert_link_to "$home/.codex/skills/$name" "${canonical}/$name" || failed=1
    fi
    [[ "$(readlink -- "$home/.claude/skills/$name")" != /* ]] || failed=1
    [[ "$(readlink -- "$home/.codex/skills/$name")" != /* ]] || failed=1
  done
  [[ ! -e "$home/.claude/skills/stale" && ! -L "$home/.claude/skills/stale" ]] || failed=1
  [[ ! -e "$home/.codex/skills/stale" && ! -L "$home/.codex/skills/stale" ]] || failed=1
  [[ ! -e "$home/.claude/skills/missing" && ! -L "$home/.claude/skills/missing" ]] || failed=1
  [[ ! -e "$home/.codex/skills/missing" && ! -L "$home/.codex/skills/missing" ]] || failed=1
  stale_after="$(sha256sum "$canonical/stale/SKILL.md" "$canonical/stale/marker")"
  [[ -d "$canonical/stale" && "$stale_before" == "$stale_after" ]] || failed=1
  [[ -f "$home/.claude/skills/unrelated-file" ]] || failed=1
  [[ -d "$home/.codex/skills/unrelated-dir" && -f "$home/.codex/skills/.system/marker" ]] || failed=1
  [[ -L "$home/.claude/skills/prefix-lookalike" && "$(readlink -- "$home/.claude/skills/prefix-lookalike")" == '../../.agents/skills-elsewhere/keep' ]] || failed=1
  [[ -L "$home/.codex/skills/external-link" && "$(readlink -- "$home/.codex/skills/external-link")" == /external/keep ]] || failed=1
  [[ -z "$(find "$home/.claude/skills" "$home/.codex/skills" -maxdepth 1 -name '.nexus-tmp.*' -print -quit)" ]] || failed=1
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  [[ "$status" -ne 0 && "$output" == *'missing skill: missing'* && "$before" == "$after" ]] || failed=1
  if (( failed == 0 )); then pass link_reconciliation; else fail link_reconciliation; fi
}

test_link_stale_ownership_and_empty_lock() {
  local failed=0 home canonical lock output status stale_before stale_after
  home="$(new_home link_stale_ownership)"
  canonical="$home/.agents/skills"
  lock="$home/.nexus/skill-lock.json"
  mkdir -p -- "$canonical"
  mv -- "$canonical" "$home/.agents/skills-real"
  ln -s -- skills-real "$canonical"
  write_skill "$canonical" stale
  printf 'stale-marker\n' >"$canonical/stale/marker"
  stale_before="$(sha256sum "$canonical/stale/SKILL.md" "$canonical/stale/marker")"
  ln -s -- /external/target "$canonical/alias"
  write_lock "$lock"
  mkdir -p "$home/.claude/skills" "$home/.codex/skills"
  ln -s -- "../../.agents/skills/alias/stale" "$home/.claude/skills/lexical-stale"
  ln -s -- "$home/.agents/skills-real/stale" "$home/.codex/skills/resolved-stale"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ ! -L "$home/.claude/skills/lexical-stale" && ! -L "$home/.codex/skills/resolved-stale" ]] || failed=1
  stale_after="$(sha256sum "$canonical/stale/SKILL.md" "$canonical/stale/marker")"
  [[ -d "$canonical/stale" && "$stale_before" == "$stale_after" ]] || failed=1
  for name in nexus-setup nexus-link nexus-install; do
    assert_link_to "$home/.claude/skills/$name" "$home/.nexus/skills/$name" || failed=1
    assert_link_to "$home/.codex/skills/$name" "$home/.nexus/skills/$name" || failed=1
  done
  if (( failed == 0 )); then pass link_stale_ownership_and_empty_lock; else fail link_stale_ownership_and_empty_lock; fi
}

test_link_desired_collisions_are_preserved() {
  local failed=0 home canonical lock output status
  home="$(new_home link_desired_collisions)"
  canonical="$home/.agents/skills"
  lock="$home/.nexus/skill-lock.json"
  write_skill "$canonical" alpha
  write_lock "$lock" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.codex/skills"
  printf 'keep\n' >"$home/.claude/skills/alpha/marker"
  ln -s -- /external/alpha "$home/.codex/skills/alpha"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -ne 0 && "$output" == *'collision at'* ]] || failed=1
  [[ -f "$home/.claude/skills/alpha/marker" ]] || failed=1
  [[ -L "$home/.codex/skills/alpha" && "$(readlink -- "$home/.codex/skills/alpha")" == /external/alpha ]] || failed=1
  if (( failed == 0 )); then pass link_desired_collisions_are_preserved; else fail link_desired_collisions_are_preserved; fi
}

test_link_snapshot_safety() {
  local failed=0 home canonical lock output status before after
  home="$(new_home link_snapshot_safety)"
  canonical="$home/.agents/skills"
  lock="$home/.nexus/skill-lock.json"
  write_skill "$canonical" alpha
  write_skill "$canonical" stale
  write_lock "$lock" alpha
  mkdir -p "$home/.claude/skills" "$home/.codex/skills"
  ln -s -- "../../.agents/skills/stale" "$home/.claude/skills/stale"
  ln -s -- "../../.agents/skills/stale" "$home/.codex/skills/stale"

  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  output="$(NEXUS_TEST_FAIL=lock_extract run_nexus "$home" link 2>&1)"; status=$?
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  [[ "$status" -ne 0 && "$output" == *'lock key extraction failed'* && "$before" == "$after" ]] || failed=1
  [[ -z "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-lock.*' -print -quit)" ]] || failed=1

  output="$(NEXUS_TEST_FAIL=lock_replace run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  assert_link_to "$home/.claude/skills/alpha" "$canonical/alpha" || failed=1
  assert_link_to "$home/.codex/skills/alpha" "$canonical/alpha" || failed=1
  [[ ! -L "$home/.claude/skills/stale" && ! -L "$home/.codex/skills/stale" ]] || failed=1
  [[ ! -e "$home/.claude/escape" && ! -e "$home/.codex/escape" && ! -e "$home/.agents/escape" ]] || failed=1
  [[ -z "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-lock.*' -print -quit)" ]] || failed=1
  if (( failed == 0 )); then pass link_snapshot_safety; else fail link_snapshot_safety; fi
}

assert_no_setup_residue() {
  local home="$1"
  [[ -z "$(find "$home" -maxdepth 3 \( -name '.nexus-lock.*' -o -name '.nexus-setup-backup.*' -o -name '.nexus-setup-lock.*' -o -name '.nexus-setup-source.*' -o -name '.nexus-setup-copy.*' -o -name '.nexus-canonical-tmp.*' -o -name '.nexus-canonical-old.*' \) -print -quit)" ]]
}

test_setup_happy_and_idempotent() {
  local failed=0 home source output before after mode
  home="$(new_home setup_happy)"
  source="$home/.agents/.skill-lock.json"
  write_lock "$source" alpha beta
  mkdir -p "$home/.claude/skills/alpha" "$home/.codex/skills/.system"
  printf 'hidden\n' >"$home/.claude/.hidden"
  printf 'executable\n' >"$home/.claude/run-me"; chmod 751 "$home/.claude/run-me"
  ln -s -- /ordinary/link "$home/.claude/ordinary-link"
  printf 'alpha-content\n' >"$home/.claude/skills/alpha/SKILL.md"
  printf 'replace-file\n' >"$home/.claude/skills/beta"
  ln -s -- /external/beta "$home/.codex/skills/beta"
  printf 'state\n' >"$home/.codex/state"
  printf 'system\n' >"$home/.codex/skills/.system/marker"
  mkdir -p "$home/.agents/skills"
  ln -s -- "../../.claude/skills/alpha" "$home/.agents/skills/alpha"
  write_skill "$home/.agents/skills" beta
  ln -s -- /external/unmanaged "$home/.agents/skills/unmanaged"
  output="$(run_nexus "$home" setup 2>&1)" || { printf '%s\n' "$output" >&2; failed=1; }
  [[ -d "$home/.claude" && -d "$home/.codex" ]] || failed=1
  [[ -f "$home/.claude-backup/.hidden" && -L "$home/.claude-backup/ordinary-link" ]] || failed=1
  mode="$(stat -c '%a' "$home/.claude-backup/run-me")"; [[ "$mode" == 751 ]] || failed=1
  [[ -d "$home/.claude-backup/skills/alpha" && -f "$home/.claude-backup/skills/alpha/SKILL.md" ]] || failed=1
  [[ -f "$home/.codex-backup/skills/.system/marker" ]] || failed=1
  [[ -d "$home/.agents/skills/alpha" && ! -L "$home/.agents/skills/alpha" ]] || failed=1
  [[ "$(cat "$home/.agents/skills/alpha/SKILL.md")" == alpha-content ]] || failed=1
  assert_link_to "$home/.claude/skills/alpha" "$home/.agents/skills/alpha" || failed=1
  assert_link_to "$home/.codex/skills/alpha" "$home/.agents/skills/alpha" || failed=1
  assert_link_to "$home/.claude/skills/beta" "$home/.agents/skills/beta" || failed=1
  assert_link_to "$home/.codex/skills/beta" "$home/.agents/skills/beta" || failed=1
  [[ -f "$home/.claude-backup/skills/beta" && -L "$home/.codex-backup/skills/beta" ]] || failed=1
  [[ -L "$home/.agents/skills/unmanaged" && "$(readlink "$home/.agents/skills/unmanaged")" == /external/unmanaged ]] || failed=1
  [[ -f "$home/.codex/skills/.system/marker" ]] || failed=1
  cmp -s "$source" "$home/.nexus/skill-lock.json" || failed=1
  [[ "$output" == *"$source"* && "$output" == *"$home/.claude-backup"* && "$output" == *"$home/.codex-backup"* ]] || failed=1
  assert_no_setup_residue "$home" || failed=1
  before="$(snapshot_tree "$home/.nexus")|$(snapshot_tree "$home/.agents")|$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.claude-backup")|$(snapshot_tree "$home/.codex-backup")"
  output="$(run_nexus "$home" setup 2>&1)" || failed=1
  after="$(snapshot_tree "$home/.nexus")|$(snapshot_tree "$home/.agents")|$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.claude-backup")|$(snapshot_tree "$home/.codex-backup")"
  [[ "$output" == *'already initialized'* && "$output" == *'/nexus:link'* && "$output" == *'$nexus-link'* && "$before" == "$after" ]] || failed=1
  if (( failed == 0 )); then pass setup_happy_and_idempotent; else fail setup_happy_and_idempotent; fi
}

test_setup_preflight_and_lock_discovery() {
  local failed=0 home one two three output before after
  home="$(new_home setup_preflight)"
  mkdir -p "$home/.agents" "$home/.claude-backup" "$home/.codex-backup"
  printf '{broken\n' >"$home/.agents/.skill-lock.json"
  printf 'keep\n' >"$home/.claude-backup/marker"
  printf 'keep\n' >"$home/.codex-backup/marker"
  before="$(snapshot_tree "$home")"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  after="$(snapshot_tree "$home")"
  [[ "$output" == *"$home/.claude-backup"* && "$output" == *"$home/.codex-backup"* && "$before" == "$after" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_candidates)"
  one="$home/.agents/.skill-lock.json"; two="$home/.skills/skill-lock.json"
  write_lock "$one" alpha; mkdir -p "$(dirname "$two")"; jq -S . "$one" >"$two"
  mkdir -p "$home/.agents/skills/alpha"; printf 'ok\n' >"$home/.agents/skills/alpha/SKILL.md"
  run_nexus "$home" setup >/dev/null 2>&1 || failed=1
  [[ "$(sha256sum "$one")" != "$(sha256sum "$two")" ]] || failed=1
  cmp -s "$one" "$home/.nexus/skill-lock.json" || failed=1

  home="$(new_home setup_conflicts)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  write_lock "$home/.agents/skill-lock.json" beta
  write_lock "$home/.skills/.skill-lock.json" gamma
  before="$(snapshot_tree "$home")"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  after="$(snapshot_tree "$home")"
  [[ "$output" == *'conflicting setup lock candidates'* && "$output" == *"$home/.agents/.skill-lock.json"* && "$output" == *"$home/.agents/skill-lock.json"* && "$output" == *"$home/.skills/.skill-lock.json"* && "$before" == "$after" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_invalid_candidate)"
  mkdir -p "$home/.agents" "$home/.skills"
  printf '{bad\n' >"$home/.agents/.skill-lock.json"
  printf '{also-bad\n' >"$home/.agents/skill-lock.json"
  write_lock "$home/.skills/.skill-lock.json" alpha
  before="$(snapshot_tree "$home")"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  after="$(snapshot_tree "$home")"
  [[ "$output" == *'invalid setup lock candidates'* && "$output" == *"$home/.agents/.skill-lock.json"* && "$output" == *"$home/.agents/skill-lock.json"* && ! -e "$home/.claude-backup" && ! -e "$home/.nexus/skill-lock.json" && "$before" == "$after" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1
  if (( failed == 0 )); then pass setup_preflight_and_lock_discovery; else fail setup_preflight_and_lock_discovery; fi
}

test_setup_backup_transaction_and_absent_roots() {
  local failed=0 home output before after seam source_hash lock_hash recovery_tx recovery_codex
  home="$(new_home setup_backup_failure)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  printf 'live\n' >"$home/.claude/marker"; printf 'live\n' >"$home/.codex/marker"
  seam="$home/backup-cp-seam"
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$*" >>"$NEXUS_BACKUP_CP_LOG"' 'exit 1' >"$seam"; chmod 755 "$seam"
  source_hash="$(sha256sum "$home/.agents/.skill-lock.json")"
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  output="$(NEXUS_BACKUP_CP="$seam" NEXUS_BACKUP_CP_LOG="$home/backup-cp.log" run_nexus "$home" setup 2>&1)" && failed=1
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  [[ -s "$home/backup-cp.log" && "$before" == "$after" && ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" && "$source_hash" == "$(sha256sum "$home/.agents/.skill-lock.json")" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_promotion_failure)"
  write_lock "$home/.agents/.skill-lock.json"
  output="$(NEXUS_TEST_FAIL=backup_promote_second run_nexus "$home" setup 2>&1)" && failed=1
  [[ ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_rollback_recovery)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  printf 'claude-original\n' >"$home/.claude/marker"; printf 'codex-original\n' >"$home/.codex/marker"
  output="$(NEXUS_TEST_FAIL=backup_promote_second,backup_rollback run_nexus "$home" setup 2>&1)" && failed=1
  recovery_tx="$(printf '%s\n' "$output" | sed -n 's/.*; \(.*\.nexus-setup-backup\.[^ ]*\) (Codex backup:.*/\1/p' | tail -n 1)"
  recovery_codex="$recovery_tx/codex-backup"
  [[ -d "$home/.claude-backup" && -f "$home/.claude-backup/marker" && -d "$recovery_tx" && -f "$recovery_codex/marker" && "$output" == *"$home/.claude-backup"* && "$output" == *"$recovery_tx"* && "$output" == *"$recovery_codex"* && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  [[ "$(find "$home" -maxdepth 1 -type d -name '.nexus-setup-backup.*' -print)" == "$recovery_tx" ]] || failed=1
  [[ -z "$(find "$home" -maxdepth 2 \( -name '.nexus-setup-source.*' -o -name '.nexus-setup-copy.*' \) -print -quit)" ]] || failed=1

  home="$(new_home setup_absent_roots)"
  write_lock "$home/.agents/.skill-lock.json"
  run_nexus "$home" setup >/dev/null 2>&1 || failed=1
  [[ -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1
  if (( failed == 0 )); then pass setup_backup_transaction_and_absent_roots; else fail setup_backup_transaction_and_absent_roots; fi
}

test_setup_canonical_failures_retain_publication() {
  local failed=0 home output original retained_temp
  home="$(new_home setup_broken_canonical)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.agents/skills" "$home/.claude/skills/alpha" "$home/.codex/skills/alpha"
  ln -s -- /missing/alpha "$home/.agents/skills/alpha"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  [[ "$output" == *'broken symlink'* && -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1
  [[ -d "$home/.claude/skills/alpha" && -d "$home/.codex/skills/alpha" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_canonical_restore_failure)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.agents/skills"
  printf 'skill\n' >"$home/.claude/skills/alpha/SKILL.md"
  ln -s -- "../../.claude/skills/alpha" "$home/.agents/skills/alpha"
  output="$(NEXUS_TEST_FAIL=canonical_promote,canonical_restore run_nexus "$home" setup 2>&1)" && failed=1
  original="$(printf '%s\n' "$output" | sed -n 's/.*canonical recovery retained: //p' | tail -n 1)"
  [[ -n "$original" && -L "$original/original" && "$(readlink "$original/original")" == '../../.claude/skills/alpha' && -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1
  [[ -z "$(find "$home/.agents/skills" -maxdepth 1 -name '.nexus-canonical-tmp.*' -print -quit)" ]] || failed=1
  [[ -d "$home/.claude/skills/alpha" ]] || failed=1

  home="$(new_home setup_canonical_cleanup_failure)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.agents/skills"
  printf 'skill\n' >"$home/.claude/skills/alpha/SKILL.md"
  ln -s -- "../../.claude/skills/alpha" "$home/.agents/skills/alpha"
  output="$(NEXUS_TEST_FAIL=canonical_promote,canonical_restore,canonical_cleanup run_nexus "$home" setup 2>&1)" && failed=1
  original="$(printf '%s\n' "$output" | sed -n 's/.*canonical recovery retained: //p' | tail -n 1)"
  retained_temp="$(printf '%s\n' "$output" | sed -n 's/.*canonical temp retained: //p' | tail -n 1)"
  [[ -L "$original/original" && -d "$retained_temp" && "$output" == *"$original"* && "$output" == *"$retained_temp"* ]] || failed=1

  home="$(new_home setup_canonical_restore)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.agents/skills"
  printf 'skill\n' >"$home/.claude/skills/alpha/SKILL.md"
  ln -s -- "../../.claude/skills/alpha" "$home/.agents/skills/alpha"
  original="$(readlink "$home/.agents/skills/alpha")"
  output="$(NEXUS_TEST_FAIL=canonical_promote run_nexus "$home" setup 2>&1)" && failed=1
  [[ -L "$home/.agents/skills/alpha" && "$(readlink "$home/.agents/skills/alpha")" == "$original" ]] || failed=1
  [[ -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1
  if (( failed == 0 )); then pass setup_canonical_failures_retain_publication; else fail setup_canonical_failures_retain_publication; fi
}

test_metadata() {
  local failed=0
  assert_contains .gitignore 'skill-lock.json' || failed=1
  if git -C "$REPO_ROOT" check-ignore -q -- skill-lock.json; then
    :
  else
    printf '  skill-lock.json is not actually ignored\n' >&2
    failed=1
  fi

  local name command
  for name in nexus-setup nexus-link nexus-install; do
    case "$name" in
      nexus-setup) command='/home/luanh/.nexus/scripts/nexus setup' ;;
      nexus-link) command='/home/luanh/.nexus/scripts/nexus link' ;;
      nexus-install) command='/home/luanh/.nexus/scripts/nexus install' ;;
    esac
    assert_file "skills/$name/SKILL.md" || failed=1
    assert_file "skills/$name/claude-command.md" || failed=1
    assert_line "skills/$name/SKILL.md" "name: $name" || failed=1
    assert_contains "skills/$name/SKILL.md" "$command" || failed=1
    assert_contains "skills/$name/claude-command.md" "$command" || failed=1
  done

  if (( failed == 0 )); then
    pass metadata
  else
    fail metadata
  fi
}

test_metadata
test_bootstrap
test_bootstrap_collision
test_bootstrap_staging_failure
test_bootstrap_lexical_managed_link
test_bootstrap_symlinked_managed_root
test_force_replacement
test_force_recovery
test_dispatcher
test_force_env_does_not_bypass_bootstrap
test_link_invalid_locks_do_not_mutate
test_link_reconciliation
test_link_stale_ownership_and_empty_lock
test_link_desired_collisions_are_preserved
test_link_snapshot_safety
test_setup_happy_and_idempotent
test_setup_preflight_and_lock_discovery
test_setup_backup_transaction_and_absent_roots
test_setup_canonical_failures_retain_publication
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
