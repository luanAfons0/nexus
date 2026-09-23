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
  [[ "$output" == *'Usage: nexus <bootstrap|setup|link|install|update|remove|new|list|check|global|help>'* ]] || {
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

# Ticket #16: global edit replaces GLOBAL.md from stdin, refuses before any
# change, and links the Instruction Paths only on first creation.

EMPTY_SHA256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

global_edit_no_link_output() {
  local output="$1"
  [[ "$output" != *'link complete'* && "$output" != *CLAUDE.md* && "$output" != *AGENTS.md* ]] || {
    printf '  unexpected link output:\n%s\n' "$output" >&2; return 1;
  }
}

test_global_edit_creates_and_links() {
  local failed=0 home output status
  home="$(global_cli_home global_edit_create)"
  printf 'hand written\n' >"$home/.codex/AGENTS.md"

  output="$(printf 'first rule\n' | run_nexus "$home" global edit 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  status %s:\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ -f "$home/.custom-skills/GLOBAL.md" && ! -L "$home/.custom-skills/GLOBAL.md" ]] || { printf '  Owner not created as a regular file\n' >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == 'first rule' ]] || { printf '  Owner content differs\n' >&2; failed=1; }
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1
  [[ "$output" == *'link complete'* ]] || { printf '  link output not forwarded:\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *"foreign entry at $home/.codex/AGENTS.md"* ]] || { printf '  Foreign Entry notice not forwarded:\n%s\n' "$output" >&2; failed=1; }
  [[ "$(cat "$home/.codex/AGENTS.md")" == 'hand written' ]] || { printf '  Foreign Entry changed\n' >&2; failed=1; }
  assert_link_to "$home/.claude/skills/mine" "$home/.custom-skills/mine" || failed=1
  [[ -z "$(find "$home/.custom-skills" -maxdepth 1 -name '.nexus-*' -print -quit)" ]] || { printf '  temp file left in the Custom Root\n' >&2; failed=1; }
  assert_custom_skill_intact "$home" || failed=1
  if (( failed == 0 )); then pass global_edit_creates_and_links; else fail global_edit_creates_and_links; fi
}

test_global_edit_clean_creation_links_both_paths() {
  local failed=0 home output status
  home="$(global_cli_home global_edit_create_clean)"
  output="$(printf 'first rule\n' | run_nexus "$home" global edit 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  status %s:\n%s\n' "$status" "$output" >&2; failed=1; }
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1
  assert_instruction_link "$home" "$home/.codex/AGENTS.md" || failed=1
  [[ "$output" != *error* ]] || { printf '  unexpected error output:\n%s\n' "$output" >&2; failed=1; }
  if (( failed == 0 )); then pass global_edit_clean_creation_links_both_paths; else fail global_edit_clean_creation_links_both_paths; fi
}

test_global_edit_overwrites_without_link() {
  local failed=0 home output status before after
  home="$(global_cli_home global_edit_overwrite)"
  printf 'old rule\n' >"$home/.custom-skills/GLOBAL.md"
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"

  output="$(printf 'new rule\nline two\n' | run_nexus "$home" global edit 2>&1)"; status=$?
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  [[ "$status" -eq 0 ]] || { printf '  status %s:\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == $'new rule\nline two' ]] || { printf '  Owner content differs\n' >&2; failed=1; }
  [[ "$before" == "$after" ]] || { printf '  Instruction Path state changed\n' >&2; failed=1; }
  [[ -z "$output" ]] || { printf '  unexpected output:\n%s\n' "$output" >&2; failed=1; }
  [[ ! -e "$home/.claude/CLAUDE.md" && ! -e "$home/.codex/AGENTS.md" ]] || { printf '  link ran\n' >&2; failed=1; }
  assert_custom_skill_intact "$home" || failed=1
  if (( failed == 0 )); then pass global_edit_overwrites_without_link; else fail global_edit_overwrites_without_link; fi
}

test_global_edit_if_match_success() {
  local failed=0 home output status sha
  home="$(global_cli_home global_edit_if_match_ok)"
  printf 'old rule\n' >"$home/.custom-skills/GLOBAL.md"
  sha="$(run_nexus "$home" global show --json | jq -r .sha256)"

  output="$(printf 'new rule\n' | run_nexus "$home" global edit --if-match "$sha" 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  status %s:\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == 'new rule' ]] || { printf '  Owner content differs\n' >&2; failed=1; }
  global_edit_no_link_output "$output" || failed=1
  assert_custom_skill_intact "$home" || failed=1
  if (( failed == 0 )); then pass global_edit_if_match_success; else fail global_edit_if_match_success; fi
}

test_global_edit_if_match_mismatch_refuses() {
  local failed=0 home output status before after actual
  home="$(global_cli_home global_edit_if_match_bad)"
  printf 'old rule\n' >"$home/.custom-skills/GLOBAL.md"
  actual="$(sha256sum <"$home/.custom-skills/GLOBAL.md" | awk '{print $1}')"
  before="$(global_cli_snapshot "$home")"

  output="$(printf 'new rule\n' | run_nexus "$home" global edit --if-match "$EMPTY_SHA256" 2>&1)"; status=$?
  after="$(global_cli_snapshot "$home")"
  [[ "$status" -eq 1 ]] || { printf '  status %s:\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *"$EMPTY_SHA256"* && "$output" == *"$actual"* ]] || { printf '  mismatch message lacks a hash:\n%s\n' "$output" >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == 'old rule' ]] || { printf '  Owner was written\n' >&2; failed=1; }
  [[ "$before" == "$after" ]] || { printf '  refused edit changed a tree\n' >&2; failed=1; }
  if (( failed == 0 )); then pass global_edit_if_match_mismatch_refuses; else fail global_edit_if_match_mismatch_refuses; fi
}

test_global_edit_empty_sha_matches_absent_and_empty() {
  local failed=0 home output status
  home="$(global_cli_home global_edit_empty_sha)"

  output="$(printf 'first rule\n' | run_nexus "$home" global edit --if-match "$EMPTY_SHA256" 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  absent: status %s:\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == 'first rule' ]] || { printf '  absent: Owner content differs\n' >&2; failed=1; }
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1

  : >"$home/.custom-skills/GLOBAL.md"
  output="$(printf 'second rule\n' | run_nexus "$home" global edit --if-match "$EMPTY_SHA256" 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  empty: status %s:\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == 'second rule' ]] || { printf '  empty: Owner content differs\n' >&2; failed=1; }
  global_edit_no_link_output "$output" || failed=1
  if (( failed == 0 )); then pass global_edit_empty_sha_matches_absent_and_empty; else fail global_edit_empty_sha_matches_absent_and_empty; fi
}

test_global_edit_empty_stdin_writes_empty_file() {
  local failed=0 home output status
  home="$(global_cli_home global_edit_empty_stdin)"
  printf 'old rule\n' >"$home/.custom-skills/GLOBAL.md"

  output="$(run_nexus "$home" global edit </dev/null 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  status %s:\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ -f "$home/.custom-skills/GLOBAL.md" && ! -s "$home/.custom-skills/GLOBAL.md" ]] || { printf '  Owner is not an empty regular file\n' >&2; failed=1; }
  assert_custom_skill_intact "$home" || failed=1
  if (( failed == 0 )); then pass global_edit_empty_stdin_writes_empty_file; else fail global_edit_empty_stdin_writes_empty_file; fi
}

# $1 label, $2 command that builds the faulty tree, $3 expected error fragment.
global_edit_fault_case() {
  local kind="$1" make="$2" fragment="$3" failed=0 home output status before after
  home="$(global_cli_home "global_edit_fault_$kind")"
  eval "$make"
  before="$(global_cli_snapshot "$home")"
  output="$(printf 'new rule\n' | run_nexus "$home" global edit 2>&1)"; status=$?
  after="$(global_cli_snapshot "$home")"
  [[ "$status" -eq 1 ]] || { printf '  %s: status %s\n' "$kind" "$status" >&2; failed=1; }
  [[ "$output" == *"$fragment"* ]] || { printf '  %s: missing fault:\n%s\n' "$kind" "$output" >&2; failed=1; }
  [[ "$before" == "$after" ]] || { printf '  %s: refused edit mutated a tree\n' "$kind" >&2; failed=1; }
  assert_custom_skill_intact "$home" || failed=1
  return "$failed"
}

test_global_edit_symlink_owner_is_refused() {
  if global_edit_fault_case symlink 'ln -s -- mine/SKILL.md "$home/.custom-skills/GLOBAL.md"' \
      'error: global instructions must be a regular file, not a symlink:'; then
    pass global_edit_symlink_owner_is_refused
  else
    fail global_edit_symlink_owner_is_refused
  fi
}

test_global_edit_directory_owner_is_refused() {
  if global_edit_fault_case directory 'mkdir -- "$home/.custom-skills/GLOBAL.md"' \
      'error: global instructions must be a regular file, not a directory:'; then
    pass global_edit_directory_owner_is_refused
  else
    fail global_edit_directory_owner_is_refused
  fi
}

test_global_edit_missing_custom_root_is_refused() {
  local failed=0 home output status
  home="$(new_home global_edit_no_root)"
  mkdir -p "$home/.claude" "$home/.codex"
  output="$(printf 'new rule\n' | run_nexus "$home" global edit 2>&1)"; status=$?
  [[ "$status" -eq 1 ]] || { printf '  status %s\n' "$status" >&2; failed=1; }
  [[ "$output" == *"error: custom skill root is absent: $home/.custom-skills"* ]] || { printf '  missing fault:\n%s\n' "$output" >&2; failed=1; }
  [[ ! -e "$home/.custom-skills" ]] || { printf '  edit created the Custom Root\n' >&2; failed=1; }
  [[ ! -e "$home/.claude/CLAUDE.md" ]] || { printf '  edit linked an Instruction Path\n' >&2; failed=1; }
  if (( failed == 0 )); then pass global_edit_missing_custom_root_is_refused; else fail global_edit_missing_custom_root_is_refused; fi
}

# First creation before setup: the write lands, then link fails on the
# absent Nexus Lock exactly as `nexus link` would, and the exit is 1.
test_global_edit_creation_without_lock_keeps_file() {
  local failed=0 home output status
  home="$(custom_home global_edit_no_lock)"
  output="$(printf 'first rule\n' | run_nexus "$home" global edit 2>&1)"; status=$?
  [[ "$status" -eq 1 ]] || { printf '  status %s:\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *'invalid version-3 lock'* ]] || { printf '  missing link lock error:\n%s\n' "$output" >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == 'first rule' ]] || { printf '  Owner not written\n' >&2; failed=1; }
  [[ ! -e "$home/.claude/CLAUDE.md" && ! -L "$home/.claude/CLAUDE.md" ]] || { printf '  Instruction Path linked without a lock\n' >&2; failed=1; }
  if (( failed == 0 )); then pass global_edit_creation_without_lock_keeps_file; else fail global_edit_creation_without_lock_keeps_file; fi
}

test_global_edit_usage_errors() {
  local failed=0 home output status before after
  home="$(global_cli_home global_edit_usage)"
  printf 'old rule\n' >"$home/.custom-skills/GLOBAL.md"
  before="$(global_cli_snapshot "$home")"
  local -a bad=('global edit --nope' 'global edit extra' 'global edit --if-match' 'global edit --if-match nothex')
  local args
  for args in "${bad[@]}"; do
    # shellcheck disable=SC2086
    output="$(printf 'new rule\n' | run_nexus "$home" $args 2>&1)"; status=$?
    [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || { printf '  "%s": status %s output %s\n' "$args" "$status" "$output" >&2; failed=1; }
  done
  after="$(global_cli_snapshot "$home")"
  [[ "$before" == "$after" ]] || { printf '  usage error changed a tree\n' >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == 'old rule' ]] || { printf '  Owner was written\n' >&2; failed=1; }
  if (( failed == 0 )); then pass global_edit_usage_errors; else fail global_edit_usage_errors; fi
}

CASE_TESTS+=(
  test_global_edit_creates_and_links
  test_global_edit_clean_creation_links_both_paths
  test_global_edit_overwrites_without_link
  test_global_edit_if_match_success
  test_global_edit_if_match_mismatch_refuses
  test_global_edit_empty_sha_matches_absent_and_empty
  test_global_edit_empty_stdin_writes_empty_file
  test_global_edit_symlink_owner_is_refused
  test_global_edit_directory_owner_is_refused
  test_global_edit_missing_custom_root_is_refused
  test_global_edit_creation_without_lock_keeps_file
  test_global_edit_usage_errors
)
