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
