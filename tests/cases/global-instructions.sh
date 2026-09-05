# Global Instructions link tests. Driven as a CLI subprocess against an
# isolated fake HOME/NEXUS_HOME, per tests/run.sh conventions. Every case
# asserts on the filesystem (symlink presence, literal relative target,
# preserved content), on exit status, and on decisive output lines.

# A fake home with a Custom Root, both Agent Homes, a canonical skill, and a
# valid lock, so link has skills to reconcile beside the Instruction Paths.
global_home() {
  local home
  home="$(custom_home "$1")"
  write_skill "$home/.agents/skills" installed
  write_skill "$home/.custom-skills" mine
  write_lock "$home/.nexus/skill-lock.json" installed
  printf '%s\n' "$home"
}

assert_instruction_link() {
  local home="$1" path="$2" expected='../.custom-skills/GLOBAL.md'
  assert_link_to "$path" "$home/.custom-skills/GLOBAL.md" || return 1
  [[ "$(readlink -- "$path")" == "$expected" ]] || {
    printf '  wrong literal target for %s: %s (expected %s)\n' "$path" "$(readlink -- "$path")" "$expected" >&2
    return 1
  }
}

assert_no_instruction_output() {
  local output="$1"
  [[ "$output" != *CLAUDE.md* && "$output" != *AGENTS.md* && "$output" != *GLOBAL.md* ]] || {
    printf '  unexpected instruction output:\n%s\n' "$output" >&2
    return 1
  }
}

test_global_link_creates_both_paths() {
  local failed=0 home output status
  home="$(global_home global_create)"
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1
  assert_instruction_link "$home" "$home/.codex/AGENTS.md" || failed=1
  [[ "$(cat "$home/.claude/CLAUDE.md")" == 'rule one' && "$(cat "$home/.codex/AGENTS.md")" == 'rule one' ]] || {
    printf '  Instruction Paths do not read the Owner content\n' >&2; failed=1;
  }
  assert_link_to "$home/.claude/skills/mine" "$home/.custom-skills/mine" || failed=1
  [[ -f "$home/.custom-skills/GLOBAL.md" && ! -L "$home/.custom-skills/GLOBAL.md" ]] || failed=1
  if (( failed == 0 )); then pass global_link_creates_both_paths; else fail global_link_creates_both_paths; fi
}

test_global_link_second_run_is_silent() {
  local failed=0 home output status before after
  home="$(global_home global_idempotent)"
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"
  run_nexus "$home" link >/dev/null 2>&1 || failed=1
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.custom-skills")"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.custom-skills")"
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$before" == "$after" ]] || { printf '  second link changed the trees\n' >&2; failed=1; }
  assert_no_instruction_output "$output" || failed=1
  if (( failed == 0 )); then pass global_link_second_run_is_silent; else fail global_link_second_run_is_silent; fi
}

test_global_link_repairs_wrong_managed_target() {
  local failed=0 home output status
  home="$(global_home global_repair)"
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"
  ln -s -- ../.custom-skills/mine/SKILL.md "$home/.claude/CLAUDE.md"
  ln -s -- ../.agents/skills/installed/SKILL.md "$home/.codex/AGENTS.md"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1
  assert_instruction_link "$home" "$home/.codex/AGENTS.md" || failed=1
  [[ -f "$home/.custom-skills/mine/SKILL.md" && -f "$home/.agents/skills/installed/SKILL.md" ]] || failed=1
  if (( failed == 0 )); then pass global_link_repairs_wrong_managed_target; else fail global_link_repairs_wrong_managed_target; fi
}

test_global_link_empty_owner_is_silent() {
  local failed=0 home output status
  home="$(global_home global_empty)"
  : >"$home/.custom-skills/GLOBAL.md"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1
  assert_instruction_link "$home" "$home/.codex/AGENTS.md" || failed=1
  assert_no_instruction_output "$output" || failed=1
  [[ ! -s "$home/.custom-skills/GLOBAL.md" ]] || failed=1
  if (( failed == 0 )); then pass global_link_empty_owner_is_silent; else fail global_link_empty_owner_is_silent; fi
}

test_global_setup_ends_with_links() {
  local failed=0 home output status
  home="$(new_home global_setup)"
  mkdir -p "$home/.claude" "$home/.codex" "$home/.custom-skills" "$home/.agents/skills"
  write_lock "$home/.agents/.skill-lock.json" alpha
  write_skill "$home/.agents/skills" alpha
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"

  output="$(run_nexus "$home" setup 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1
  assert_instruction_link "$home" "$home/.codex/AGENTS.md" || failed=1
  assert_link_to "$home/.claude/skills/alpha" "$home/.agents/skills/alpha" || failed=1
  if (( failed == 0 )); then pass global_setup_ends_with_links; else fail global_setup_ends_with_links; fi
}

test_global_bootstrap_never_links_instructions() {
  local failed=0 home output status
  home="$(global_home global_bootstrap)"
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"

  output="$(run_nexus "$home" bootstrap 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ ! -e "$home/.claude/CLAUDE.md" && ! -L "$home/.claude/CLAUDE.md" ]] || { printf '  bootstrap created the Claude Instruction Path\n' >&2; failed=1; }
  [[ ! -e "$home/.codex/AGENTS.md" && ! -L "$home/.codex/AGENTS.md" ]] || { printf '  bootstrap created the Codex Instruction Path\n' >&2; failed=1; }
  assert_link_to "$home/.claude/skills/nexus-link" "$home/.nexus/skills/nexus-link" || failed=1
  if (( failed == 0 )); then pass global_bootstrap_never_links_instructions; else fail global_bootstrap_never_links_instructions; fi
}

CASE_TESTS+=(
  test_global_link_creates_both_paths
  test_global_link_second_run_is_silent
  test_global_link_repairs_wrong_managed_target
  test_global_link_empty_owner_is_silent
  test_global_setup_ends_with_links
  test_global_bootstrap_never_links_instructions
)

# Ticket #9: legal states are notices with exit 0.

test_global_absent_owner_is_a_notice() {
  local failed=0 home output status
  home="$(global_home global_absent_owner)"
  printf 'hand written\n' >"$home/.claude/CLAUDE.md"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *"global instructions are absent: $home/.custom-skills/GLOBAL.md"* ]] || {
    printf '  missing absent-owner notice:\n%s\n' "$output" >&2; failed=1;
  }
  [[ "$(grep -c 'global instructions are absent' <<<"$output")" -eq 1 ]] || { printf '  notice printed more than once\n' >&2; failed=1; }
  [[ "$output" != *error* ]] || { printf '  unexpected error output\n' >&2; failed=1; }
  [[ -f "$home/.claude/CLAUDE.md" && ! -L "$home/.claude/CLAUDE.md" && "$(cat "$home/.claude/CLAUDE.md")" == 'hand written' ]] || {
    printf '  physical CLAUDE.md was not preserved byte-identical\n' >&2; failed=1;
  }
  [[ ! -e "$home/.codex/AGENTS.md" && ! -L "$home/.codex/AGENTS.md" ]] || failed=1
  assert_link_to "$home/.claude/skills/mine" "$home/.custom-skills/mine" || failed=1
  assert_link_to "$home/.codex/skills/installed" "$home/.agents/skills/installed" || failed=1
  if (( failed == 0 )); then pass global_absent_owner_is_a_notice; else fail global_absent_owner_is_a_notice; fi
}

test_global_absent_owner_removes_stale_link_only() {
  local failed=0 home output status
  home="$(global_home global_absent_stale)"
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"
  run_nexus "$home" link >/dev/null 2>&1 || failed=1
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1
  rm -- "$home/.custom-skills/GLOBAL.md"
  rm -- "$home/.codex/AGENTS.md"
  ln -s -- /unrelated/AGENTS.md "$home/.codex/AGENTS.md"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ ! -e "$home/.claude/CLAUDE.md" && ! -L "$home/.claude/CLAUDE.md" ]] || { printf '  dangling Managed Link was not removed\n' >&2; failed=1; }
  [[ "$output" == *"removed stale managed link: $home/.claude/CLAUDE.md"* ]] || { printf '  missing stale removal line\n' >&2; failed=1; }
  [[ -L "$home/.codex/AGENTS.md" && "$(readlink -- "$home/.codex/AGENTS.md")" == /unrelated/AGENTS.md ]] || {
    printf '  unrelated symlink was not preserved\n' >&2; failed=1;
  }
  [[ "$output" != *"$home/.codex/AGENTS.md"* ]] || { printf '  unexpected per-path notice for the unrelated symlink\n' >&2; failed=1; }
  if (( failed == 0 )); then pass global_absent_owner_removes_stale_link_only; else fail global_absent_owner_removes_stale_link_only; fi
}

test_global_foreign_file_is_preserved_with_hint() {
  local failed=0 home output status
  home="$(global_home global_foreign_file)"
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"
  printf 'hand written\n' >"$home/.claude/CLAUDE.md"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *"foreign entry at $home/.claude/CLAUDE.md"* ]] || { printf '  missing foreign notice:\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *"mv $home/.claude/CLAUDE.md $home/.custom-skills/GLOBAL.md"* ]] || { printf '  missing move hint\n' >&2; failed=1; }
  [[ "$output" != *error* ]] || { printf '  unexpected error output\n' >&2; failed=1; }
  [[ -f "$home/.claude/CLAUDE.md" && ! -L "$home/.claude/CLAUDE.md" && "$(cat "$home/.claude/CLAUDE.md")" == 'hand written' ]] || {
    printf '  physical CLAUDE.md was not preserved\n' >&2; failed=1;
  }
  assert_instruction_link "$home" "$home/.codex/AGENTS.md" || failed=1
  [[ -z "$(find "$home/.claude" -maxdepth 1 -name '.nexus-*' -print -quit)" ]] || { printf '  staging residue left in the Agent Home\n' >&2; failed=1; }
  if (( failed == 0 )); then pass global_foreign_file_is_preserved_with_hint; else fail global_foreign_file_is_preserved_with_hint; fi
}

test_global_foreign_symlink_is_preserved_with_hint() {
  local failed=0 home output status
  home="$(global_home global_foreign_symlink)"
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"
  ln -s -- /unrelated/AGENTS.md "$home/.codex/AGENTS.md"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *"foreign entry at $home/.codex/AGENTS.md"* && "$output" == *"mv $home/.codex/AGENTS.md $home/.custom-skills/GLOBAL.md"* ]] || {
    printf '  missing foreign notice for the unrelated symlink:\n%s\n' "$output" >&2; failed=1;
  }
  [[ -L "$home/.codex/AGENTS.md" && "$(readlink -- "$home/.codex/AGENTS.md")" == /unrelated/AGENTS.md ]] || {
    printf '  unrelated symlink was not preserved\n' >&2; failed=1;
  }
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1
  if (( failed == 0 )); then pass global_foreign_symlink_is_preserved_with_hint; else fail global_foreign_symlink_is_preserved_with_hint; fi
}

# Skill links create the Native Skill Roots first (put_link creates the
# parent), so by the time the Instruction Paths are reconciled the Agent Home
# exists. This case fixes the reachable contract: an Agent Home that is absent
# before link is not an error, the Claude Instruction Path is still linked,
# and no physical file appears at the Codex Instruction Path.
test_global_absent_agent_home_is_not_an_error() {
  local failed=0 home output status
  home="$(global_home global_no_codex)"
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"
  rm -rf -- "$home/.codex"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$output" != *error* ]] || { printf '  unexpected error output\n' >&2; failed=1; }
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1
  [[ ! -e "$home/.codex/AGENTS.md" || -L "$home/.codex/AGENTS.md" ]] || { printf '  physical file at the Codex Instruction Path\n' >&2; failed=1; }
  if (( failed == 0 )); then pass global_absent_agent_home_is_not_an_error; else fail global_absent_agent_home_is_not_an_error; fi
}

CASE_TESTS+=(
  test_global_absent_owner_is_a_notice
  test_global_absent_owner_removes_stale_link_only
  test_global_foreign_file_is_preserved_with_hint
  test_global_foreign_symlink_is_preserved_with_hint
  test_global_absent_agent_home_is_not_an_error
)

# Ticket #10: an invalid GLOBAL.md is a preflight fault that changes nothing.

global_snapshot() {
  local home="$1"
  printf '%s|%s|%s|%s\n' \
    "$(snapshot_tree "$home/.claude")" "$(snapshot_tree "$home/.codex")" \
    "$(snapshot_tree "$home/.agents")" "$(snapshot_tree "$home/.custom-skills")"
}

# $1 kind label, $2 command that creates the invalid Owner in the fake home.
global_invalid_owner_case() {
  local kind="$1" make="$2" failed=0 home output status before after
  home="$(global_home "global_invalid_$kind")"
  printf 'hand written\n' >"$home/.claude/CLAUDE.md"
  ln -s -- ../.custom-skills/mine/SKILL.md "$home/.codex/AGENTS.md"
  eval "$make"
  before="$(global_snapshot "$home")"

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  after="$(global_snapshot "$home")"
  [[ "$status" -eq 1 ]] || { printf '  %s: link status %s\n' "$kind" "$status" >&2; failed=1; }
  [[ "$output" == *"error: global instructions must be a regular file"* && "$output" == *"$home/.custom-skills/GLOBAL.md"* ]] || {
    printf '  %s: missing preflight error:\n%s\n' "$kind" "$output" >&2; failed=1;
  }
  [[ "$output" == *'no changes were made'* ]] || { printf '  %s: missing no-change line\n' "$kind" >&2; failed=1; }
  [[ "$before" == "$after" ]] || { printf '  %s: link mutated a root or an Instruction Path\n' "$kind" >&2; failed=1; }
  [[ ! -e "$home/.claude/skills/mine" && ! -e "$home/.claude/skills/nexus-link" ]] || { printf '  %s: skill links were created\n' "$kind" >&2; failed=1; }

  output="$(run_nexus "$home" list 2>&1)"; status=$?
  after="$(global_snapshot "$home")"
  [[ "$status" -ne 0 ]] || { printf '  %s: list status %s\n' "$kind" "$status" >&2; failed=1; }
  [[ "$output" == *"error: global instructions must be a regular file"* ]] || { printf '  %s: list missing preflight error\n' "$kind" >&2; failed=1; }
  [[ "$before" == "$after" ]] || { printf '  %s: list mutated a tree\n' "$kind" >&2; failed=1; }
  return "$failed"
}

test_global_owner_symlink_is_a_fault() {
  if global_invalid_owner_case symlink 'ln -s -- mine/SKILL.md "$home/.custom-skills/GLOBAL.md"'; then
    pass global_owner_symlink_is_a_fault
  else
    fail global_owner_symlink_is_a_fault
  fi
}

test_global_owner_directory_is_a_fault() {
  if global_invalid_owner_case directory 'mkdir -- "$home/.custom-skills/GLOBAL.md"'; then
    pass global_owner_directory_is_a_fault
  else
    fail global_owner_directory_is_a_fault
  fi
}

CASE_TESTS+=(
  test_global_owner_symlink_is_a_fault
  test_global_owner_directory_is_a_fault
)
