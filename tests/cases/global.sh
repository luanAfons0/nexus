# global subcommand tests. Driven as a CLI subprocess against an isolated
# fake HOME/NEXUS_HOME, per tests/run.sh conventions. Every case asserts on
# the filesystem, on exit status, and on decisive output lines. The Custom
# Skill beside GLOBAL.md must be byte-identical after every case.

# A fake home with a Custom Root, both Agent Homes, one Custom Skill, and a
# valid lock. The Custom Skill content is the byte-identity witness.
global_cli_home() {
  local home
  home="$(global_home "$1")"
  printf 'custom content\n' >"$home/.custom-skills/mine/notes.md"
  printf '%s\n' "$home"
}

global_cli_snapshot() {
  local home="$1"
  printf '%s|%s|%s|%s|%s\n' \
    "$(snapshot_tree "$home/.claude")" "$(snapshot_tree "$home/.codex")" \
    "$(snapshot_tree "$home/.agents")" "$(snapshot_tree "$home/.custom-skills")" \
    "$(cat "$home/.custom-skills/mine/SKILL.md" "$home/.custom-skills/mine/notes.md" 2>/dev/null)"
}

assert_custom_skill_intact() {
  local home="$1"
  [[ "$(cat "$home/.custom-skills/mine/notes.md")" == 'custom content' ]] || {
    printf '  Custom Skill content changed\n' >&2; return 1;
  }
  [[ -f "$home/.custom-skills/mine/SKILL.md" && ! -L "$home/.custom-skills/mine/SKILL.md" ]] || {
    printf '  Custom Skill SKILL.md changed\n' >&2; return 1;
  }
}

test_global_show_plain_prints_bytes() {
  local failed=0 home output status before after
  home="$(global_cli_home global_show_plain)"
  printf 'rule one\n\nrule two' >"$home/.custom-skills/GLOBAL.md"
  before="$(global_cli_snapshot "$home")"

  output="$(run_nexus "$home" global show; printf x)"; status=$?
  after="$(global_cli_snapshot "$home")"
  [[ "$status" -eq 0 ]] || { printf '  status %s\n' "$status" >&2; failed=1; }
  [[ "$output" == $'rule one\n\nrule twox' ]] || { printf '  bytes differ:\n%s\n' "$output" >&2; failed=1; }
  [[ "$before" == "$after" ]] || { printf '  show changed a tree\n' >&2; failed=1; }
  assert_custom_skill_intact "$home" || failed=1
  if (( failed == 0 )); then pass global_show_plain_prints_bytes; else fail global_show_plain_prints_bytes; fi
}

test_global_show_json_present() {
  local failed=0 home output status expected_sha
  home="$(global_cli_home global_show_json)"
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"
  ln -s -- ../.custom-skills/GLOBAL.md "$home/.claude/CLAUDE.md"
  printf 'hand written\n' >"$home/.codex/AGENTS.md"
  expected_sha="$(sha256sum <"$home/.custom-skills/GLOBAL.md" | awk '{print $1}')"

  output="$(run_nexus "$home" global show --json)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  status %s\n' "$status" >&2; failed=1; }
  jq -e . <<<"$output" >/dev/null || { printf '  invalid JSON:\n%s\n' "$output" >&2; failed=1; }
  jq -e --arg owner "$home/.custom-skills/GLOBAL.md" --arg sha "$expected_sha" '
    .owner == $owner and .present == true and .sha256 == $sha and
    .content == "rule one\n" and .claude == "linked" and .codex == "foreign"
  ' <<<"$output" >/dev/null || { printf '  unexpected JSON:\n%s\n' "$output" >&2; failed=1; }
  [[ "$(jq -r 'keys | join(",")' <<<"$output")" == 'claude,codex,content,owner,present,sha256' ]] || {
    printf '  unexpected key set:\n%s\n' "$output" >&2; failed=1;
  }
  assert_custom_skill_intact "$home" || failed=1
  if (( failed == 0 )); then pass global_show_json_present; else fail global_show_json_present; fi
}

test_global_show_absent_owner() {
  local failed=0 home output status
  home="$(global_cli_home global_show_absent)"
  rm -rf -- "$home/.codex"

  output="$(run_nexus "$home" global show 2>&1; printf x)"; status=$?
  [[ "$status" -eq 0 && "$output" == 'x' ]] || { printf '  plain absent: status %s output %s\n' "$status" "$output" >&2; failed=1; }

  output="$(run_nexus "$home" global show --json)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  json absent: status %s\n' "$status" >&2; failed=1; }
  jq -e --arg owner "$home/.custom-skills/GLOBAL.md" '
    .owner == $owner and .present == false and .sha256 == null and .content == null and
    .claude == "absent" and .codex == "no home"
  ' <<<"$output" >/dev/null || { printf '  unexpected absent JSON:\n%s\n' "$output" >&2; failed=1; }
  [[ ! -e "$home/.custom-skills/GLOBAL.md" && ! -e "$home/.codex" ]] || { printf '  show created a path\n' >&2; failed=1; }
  if (( failed == 0 )); then pass global_show_absent_owner; else fail global_show_absent_owner; fi
}

# $1 label, $2 command that builds the faulty tree, $3 expected error fragment.
global_show_fault_case() {
  local kind="$1" make="$2" fragment="$3" failed=0 home output status before after form
  home="$(global_cli_home "global_show_fault_$kind")"
  eval "$make"
  before="$(global_cli_snapshot "$home")"
  for form in '' '--json'; do
    # shellcheck disable=SC2086
    output="$(run_nexus "$home" global show $form 2>&1)"; status=$?
    after="$(global_cli_snapshot "$home")"
    [[ "$status" -eq 1 ]] || { printf '  %s %s: status %s\n' "$kind" "$form" "$status" >&2; failed=1; }
    [[ "$output" == *"$fragment"* ]] || { printf '  %s %s: missing fault:\n%s\n' "$kind" "$form" "$output" >&2; failed=1; }
    [[ "$before" == "$after" ]] || { printf '  %s %s: show mutated a tree\n' "$kind" "$form" >&2; failed=1; }
  done
  return "$failed"
}

test_global_show_symlink_owner_is_a_fault() {
  if global_show_fault_case symlink 'ln -s -- mine/SKILL.md "$home/.custom-skills/GLOBAL.md"' \
      'error: global instructions must be a regular file, not a symlink:'; then
    pass global_show_symlink_owner_is_a_fault
  else
    fail global_show_symlink_owner_is_a_fault
  fi
}

test_global_show_directory_owner_is_a_fault() {
  if global_show_fault_case directory 'mkdir -- "$home/.custom-skills/GLOBAL.md"' \
      'error: global instructions must be a regular file, not a directory:'; then
    pass global_show_directory_owner_is_a_fault
  else
    fail global_show_directory_owner_is_a_fault
  fi
}

test_global_show_missing_custom_root_is_a_fault() {
  local failed=0 home output status form
  home="$(new_home global_show_no_root)"
  mkdir -p "$home/.claude" "$home/.codex"
  for form in '' '--json'; do
    # shellcheck disable=SC2086
    output="$(run_nexus "$home" global show $form 2>&1)"; status=$?
    [[ "$status" -eq 1 ]] || { printf '  %s: status %s\n' "$form" "$status" >&2; failed=1; }
    [[ "$output" == *"error: custom skill root is absent: $home/.custom-skills"* ]] || {
      printf '  %s: missing fault:\n%s\n' "$form" "$output" >&2; failed=1;
    }
    [[ ! -e "$home/.custom-skills" ]] || { printf '  show created the Custom Root\n' >&2; failed=1; }
  done
  if (( failed == 0 )); then pass global_show_missing_custom_root_is_a_fault; else fail global_show_missing_custom_root_is_a_fault; fi
}

test_global_show_usage_errors() {
  local failed=0 home output status
  home="$(global_cli_home global_show_usage)"
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"
  local -a bad=('global' 'global nope' 'global show --nope' 'global show extra' 'global show --json extra')
  local args
  for args in "${bad[@]}"; do
    # shellcheck disable=SC2086
    output="$(run_nexus "$home" $args 2>&1)"; status=$?
    [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || { printf '  "%s": status %s output %s\n' "$args" "$status" "$output" >&2; failed=1; }
  done
  assert_custom_skill_intact "$home" || failed=1
  if (( failed == 0 )); then pass global_show_usage_errors; else fail global_show_usage_errors; fi
}

test_global_help_lists_global() {
  local failed=0 home output
  home="$(new_home global_help)"
  output="$(run_nexus "$home" help)" || failed=1
  [[ "$output" == *'Usage: nexus <bootstrap|setup|link|install|update|remove|new|list|global|help>'* ]] || {
    printf '  usage line lacks global:\n%s\n' "$output" >&2; failed=1;
  }
  [[ "$output" == *$'\nglobal '* ]] || { printf '  no global subcommand line\n' >&2; failed=1; }
  if (( failed == 0 )); then pass global_help_lists_global; else fail global_help_lists_global; fi
}

CASE_TESTS+=(
  test_global_show_plain_prints_bytes
  test_global_show_json_present
  test_global_show_absent_owner
  test_global_show_symlink_owner_is_a_fault
  test_global_show_directory_owner_is_a_fault
  test_global_show_missing_custom_root_is_a_fault
  test_global_show_usage_errors
  test_global_help_lists_global
)
