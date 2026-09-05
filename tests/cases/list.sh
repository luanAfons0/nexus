# list subcommand tests. Driven as a CLI subprocess against an isolated fake
# HOME/NEXUS_HOME, per tests/run.sh conventions.

list_write_lock() {
  local path="$1" src1="$2" hash1="$3" updated1="$4" src2="$5" hash2="$6" updated2="$7"
  mkdir -p -- "$(dirname -- "$path")"
  jq -n \
    --arg src1 "$src1" --arg hash1 "$hash1" --arg updated1 "$updated1" \
    --arg src2 "$src2" --arg hash2 "$hash2" --arg updated2 "$updated2" '
    {
      version: 3,
      skills: {
        "alpha-skill": { source: $src1, sourceType: "github", skillFolderHash: $hash1,
                          installedAt: $updated1, updatedAt: $updated1 },
        "zeta-skill":  { source: $src2, sourceType: "github", skillFolderHash: $hash2,
                          installedAt: $updated2, updatedAt: $updated2 }
      }
    }' >"$path"
}

test_list_with_lock_custom_and_control() {
  local failed=0 home custom output status
  local src1="owner/repo-a" hash1="0123456789abcdef0123456789abcdef01234567" updated1="2026-01-01T00:00:00Z"
  local src2="owner/repo-z" hash2="fedcba9876543210fedcba9876543210fedcba98" updated2="2026-02-02T00:00:00Z"
  local expected header

  home="$(custom_home list_full)"
  custom="$home/.custom-skills"
  write_skill "$custom" middle-skill
  list_write_lock "$home/.nexus/skill-lock.json" "$src1" "$hash1" "$updated1" "$src2" "$hash2" "$updated2"

  output="$(run_nexus "$home" list)"; status=$?
  header="$(printf 'name\tkind\tsource\thash\tupdated')"
  expected="$header
$(printf 'alpha-skill\tinstalled\t%s\t%s\t%s' "$src1" "${hash1:0:8}" "$updated1")
$(printf 'middle-skill\tcustom\t-\t-\t-')
$(printf 'nexus-help\tcontrol\t-\t-\t-')
$(printf 'nexus-install\tcontrol\t-\t-\t-')
$(printf 'nexus-link\tcontrol\t-\t-\t-')
$(printf 'nexus-new\tcontrol\t-\t-\t-')
$(printf 'nexus-remove\tcontrol\t-\t-\t-')
$(printf 'nexus-setup\tcontrol\t-\t-\t-')
$(printf 'nexus-update\tcontrol\t-\t-\t-')
$(printf 'zeta-skill\tinstalled\t%s\t%s\t%s' "$src2" "${hash2:0:8}" "$updated2")
global instructions: absent ($custom/GLOBAL.md) (claude: absent, codex: absent)"

  [[ "$status" -eq 0 ]] || { printf '  unexpected status: %s\n' "$status" >&2; failed=1; }
  [[ "$output" == "$expected" ]] || {
    printf '  unexpected list output\n--- got ---\n%s\n--- want ---\n%s\n' "$output" "$expected" >&2
    failed=1
  }
  if (( failed == 0 )); then pass list_with_lock_custom_and_control; else fail list_with_lock_custom_and_control; fi
}

test_list_without_lock() {
  local failed=0 home custom output status
  home="$(custom_home list_no_lock)"
  custom="$home/.custom-skills"
  write_skill "$custom" only-custom

  output="$(run_nexus "$home" list 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  unexpected status: %s\n' "$status" >&2; failed=1; }
  [[ "$output" == *"lock is absent: $home/.nexus/skill-lock.json"* ]] || {
    printf '  missing absent-lock info line\n' >&2; failed=1;
  }
  [[ "$output" == *$'only-custom\tcustom\t-\t-\t-'* ]] || { printf '  missing custom row\n' >&2; failed=1; }
  [[ "$output" == *$'nexus-setup\tcontrol\t-\t-\t-'* ]] || { printf '  missing control row\n' >&2; failed=1; }
  if (( failed == 0 )); then pass list_without_lock; else fail list_without_lock; fi
}

test_list_invalid_lock() {
  local failed=0 home output status
  home="$(custom_home list_invalid_lock)"
  mkdir -p -- "$home/.nexus"
  printf '{"version": 2, "skills": {}}\n' >"$home/.nexus/skill-lock.json"

  output="$(run_nexus "$home" list 2>&1)"; status=$?
  [[ "$status" -eq 1 ]] || { printf '  unexpected status: %s\n' "$status" >&2; failed=1; }
  [[ "$output" == *'invalid version-3 lock'* ]] || { printf '  missing validation error\n' >&2; failed=1; }
  if (( failed == 0 )); then pass list_invalid_lock; else fail list_invalid_lock; fi
}

test_list_rejects_extra_args() {
  local failed=0 home output status
  home="$(new_home list_extra_args)"
  output="$(run_nexus "$home" list extra 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || failed=1
  if (( failed == 0 )); then pass list_rejects_extra_args; else fail list_rejects_extra_args; fi
}

test_help_content() {
  local failed=0 home output status alias
  home="$(new_home help_content)"
  for alias in help -h --help; do
    output="$(run_nexus "$home" "$alias")"; status=$?
    [[ "$status" -eq 0 ]] || { printf '  %s: unexpected status %s\n' "$alias" "$status" >&2; failed=1; }
    [[ "$output" == *'Usage: nexus <bootstrap|setup|link|install|update|remove|new|list|global|help>'* ]] || {
      printf '  %s: missing usage line\n' "$alias" >&2; failed=1;
    }
    [[ "$output" == *'list [--json]'* ]] || { printf '  %s: help lacks list --json\n' "$alias" >&2; failed=1; }
    local sub
    for sub in bootstrap setup link install update remove new list global help; do
      [[ "$output" == *"$sub"* ]] || { printf '  %s: missing subcommand %s\n' "$alias" "$sub" >&2; failed=1; }
    done
  done
  if (( failed == 0 )); then pass help_content; else fail help_content; fi
}

test_help_rejects_extra_args() {
  local failed=0 home output status
  home="$(new_home help_extra_args)"
  output="$(run_nexus "$home" help extra 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || failed=1
  if (( failed == 0 )); then pass help_rejects_extra_args; else fail help_rejects_extra_args; fi
}

# The Global Instructions line reports each Instruction Path state without
# changing anything. One fake home per state.
list_global_line() {
  local home="$1" output
  output="$(run_nexus "$home" list 2>&1)" || { printf '%s\n' "$output" >&2; return 1; }
  printf '%s\n' "$output" | tail -n 1
}

test_list_global_instructions_states() {
  local failed=0 home custom line before after
  home="$(custom_home list_global)"
  custom="$home/.custom-skills"
  printf 'rule one\n' >"$custom/GLOBAL.md"

  # Both absent: Agent Homes present, nothing at either Instruction Path.
  line="$(list_global_line "$home")" || failed=1
  [[ "$line" == "global instructions: $custom/GLOBAL.md (claude: absent, codex: absent)" ]] || {
    printf '  unexpected absent line: %s\n' "$line" >&2; failed=1;
  }

  # linked and foreign.
  ln -s -- ../.custom-skills/GLOBAL.md "$home/.claude/CLAUDE.md"
  printf 'hand written\n' >"$home/.codex/AGENTS.md"
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$custom")"
  line="$(list_global_line "$home")" || failed=1
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$custom")"
  [[ "$line" == "global instructions: $custom/GLOBAL.md (claude: linked, codex: foreign)" ]] || {
    printf '  unexpected linked/foreign line: %s\n' "$line" >&2; failed=1;
  }
  [[ "$before" == "$after" ]] || { printf '  list changed the filesystem\n' >&2; failed=1; }

  # An unrelated symlink is foreign too.
  rm -- "$home/.codex/AGENTS.md"
  ln -s -- /unrelated/AGENTS.md "$home/.codex/AGENTS.md"
  line="$(list_global_line "$home")" || failed=1
  [[ "$line" == *'codex: foreign)' ]] || { printf '  unrelated symlink not foreign: %s\n' "$line" >&2; failed=1; }

  # no home.
  rm -rf -- "$home/.codex"
  line="$(list_global_line "$home")" || failed=1
  [[ "$line" == "global instructions: $custom/GLOBAL.md (claude: linked, codex: no home)" ]] || {
    printf '  unexpected no-home line: %s\n' "$line" >&2; failed=1;
  }
  [[ ! -e "$home/.codex" ]] || { printf '  list created the Codex Agent Home\n' >&2; failed=1; }

  # Absent Owner form, with per-agent states still reported.
  rm -- "$custom/GLOBAL.md"
  line="$(list_global_line "$home")" || failed=1
  [[ "$line" == "global instructions: absent ($custom/GLOBAL.md) (claude: foreign, codex: no home)" ]] || {
    printf '  unexpected absent-owner line: %s\n' "$line" >&2; failed=1;
  }
  if (( failed == 0 )); then pass list_global_instructions_states; else fail list_global_instructions_states; fi
}

# Ticket #17: list --json emits one object a script can read; the table is
# byte-identical to before.
test_list_json_with_lock_custom_and_control() {
  local failed=0 home custom output status table
  local src1="owner/repo-a" hash1="0123456789abcdef0123456789abcdef01234567" updated1="2026-01-01T00:00:00Z"
  local src2="owner/repo-z" hash2="fedcba9876543210fedcba9876543210fedcba98" updated2="2026-02-02T00:00:00Z"
  home="$(custom_home list_json)"
  custom="$home/.custom-skills"
  write_skill "$custom" middle-skill
  list_write_lock "$home/.nexus/skill-lock.json" "$src1" "$hash1" "$updated1" "$src2" "$hash2" "$updated2"
  printf 'rule one\n' >"$custom/GLOBAL.md"
  ln -s -- ../.custom-skills/GLOBAL.md "$home/.claude/CLAUDE.md"

  output="$(run_nexus "$home" list --json 2>/dev/null)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  unexpected status: %s\n' "$status" >&2; failed=1; }
  jq -e . <<<"$output" >/dev/null || { printf '  invalid JSON:\n%s\n' "$output" >&2; failed=1; }
  [[ "$(jq -r 'keys | join(",")' <<<"$output")" == 'globalInstructions,skills' ]] || { printf '  unexpected top-level keys\n' >&2; failed=1; }
  [[ "$(jq -r '.skills | map(.name) | join(",")' <<<"$output")" == \
     'alpha-skill,middle-skill,nexus-help,nexus-install,nexus-link,nexus-new,nexus-remove,nexus-setup,nexus-update,zeta-skill' ]] || {
    printf '  unexpected row order or set:\n%s\n' "$output" >&2; failed=1;
  }
  jq -e --arg src "$src1" --arg hash "$hash1" --arg updated "$updated1" '
    .skills[0] == { name: "alpha-skill", kind: "installed", source: $src, hash: $hash, updatedAt: $updated }
  ' <<<"$output" >/dev/null || { printf '  unexpected installed row\n' >&2; failed=1; }
  jq -e '.skills[1] == { name: "middle-skill", kind: "custom", source: null, hash: null, updatedAt: null }' <<<"$output" >/dev/null || {
    printf '  unexpected custom row\n' >&2; failed=1;
  }
  jq -e '.skills[2] == { name: "nexus-help", kind: "control", source: null, hash: null, updatedAt: null }' <<<"$output" >/dev/null || {
    printf '  unexpected control row\n' >&2; failed=1;
  }
  jq -e --arg owner "$custom/GLOBAL.md" '
    .globalInstructions.owner == $owner and .globalInstructions.present == true and
    (.globalInstructions.sha256 | length) == 64 and .globalInstructions.claude == "linked" and
    .globalInstructions.codex == "absent" and (.globalInstructions | has("content") | not)
  ' <<<"$output" >/dev/null || { printf '  unexpected globalInstructions:\n%s\n' "$output" >&2; failed=1; }

  # The table is unchanged by the flag's existence.
  table="$(run_nexus "$home" list)" || failed=1
  [[ "$table" == *$'alpha-skill\tinstalled\t'"$src1"$'\t'"${hash1:0:8}"$'\t'"$updated1"* ]] || { printf '  table row changed\n' >&2; failed=1; }
  [[ "$table" != *'{'* ]] || { printf '  table contains JSON\n' >&2; failed=1; }
  if (( failed == 0 )); then pass list_json_with_lock_custom_and_control; else fail list_json_with_lock_custom_and_control; fi
}

test_list_json_without_lock() {
  local failed=0 home custom stdout stderr status
  home="$(custom_home list_json_no_lock)"
  custom="$home/.custom-skills"
  write_skill "$custom" only-custom
  stderr="$(mktemp)"
  stdout="$(run_nexus "$home" list --json 2>"$stderr")"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  unexpected status: %s\n' "$status" >&2; failed=1; }
  jq -e . <<<"$stdout" >/dev/null || { printf '  stdout is not valid JSON:\n%s\n' "$stdout" >&2; failed=1; }
  [[ "$(cat "$stderr")" == *"lock is absent: $home/.nexus/skill-lock.json"* ]] || { printf '  info line not on stderr\n' >&2; failed=1; }
  [[ "$(jq -r '.skills | map(.kind) | unique | join(",")' <<<"$stdout")" == 'control,custom' ]] || { printf '  unexpected kinds\n' >&2; failed=1; }
  jq -e '.skills[] | select(.name == "only-custom") | .kind == "custom"' <<<"$stdout" >/dev/null || { printf '  missing custom row\n' >&2; failed=1; }
  jq -e '.globalInstructions.present == false and .globalInstructions.sha256 == null' <<<"$stdout" >/dev/null || { printf '  unexpected globalInstructions\n' >&2; failed=1; }
  rm -f -- "$stderr"
  if (( failed == 0 )); then pass list_json_without_lock; else fail list_json_without_lock; fi
}

test_list_json_faults_and_usage() {
  local failed=0 home output status
  home="$(custom_home list_json_faults)"
  mkdir -p -- "$home/.nexus"
  printf '{"version": 2, "skills": {}}\n' >"$home/.nexus/skill-lock.json"
  output="$(run_nexus "$home" list --json 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'invalid version-3 lock'* ]] || { printf '  invalid lock: status %s\n' "$status" >&2; failed=1; }
  rm -- "$home/.nexus/skill-lock.json"
  mkdir -- "$home/.custom-skills/GLOBAL.md"
  output="$(run_nexus "$home" list --json 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'global instructions must be a regular file'* ]] || { printf '  owner fault: status %s\n' "$status" >&2; failed=1; }
  rmdir -- "$home/.custom-skills/GLOBAL.md"
  output="$(run_nexus "$home" list --nope 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || { printf '  unknown flag: status %s\n' "$status" >&2; failed=1; }
  output="$(run_nexus "$home" list --json extra 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || { printf '  extra positional: status %s\n' "$status" >&2; failed=1; }
  if (( failed == 0 )); then pass list_json_faults_and_usage; else fail list_json_faults_and_usage; fi
}

CASE_TESTS+=(
  test_list_json_with_lock_custom_and_control
  test_list_json_without_lock
  test_list_json_faults_and_usage
  test_list_global_instructions_states
  test_list_with_lock_custom_and_control
  test_list_without_lock
  test_list_invalid_lock
  test_list_rejects_extra_args
  test_help_content
  test_help_rejects_extra_args
)
