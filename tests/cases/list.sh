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
$(printf 'zeta-skill\tinstalled\t%s\t%s\t%s' "$src2" "${hash2:0:8}" "$updated2")"

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
    [[ "$output" == *'Usage: nexus <bootstrap|setup|link|install|update|remove|new|list|help>'* ]] || {
      printf '  %s: missing usage line\n' "$alias" >&2; failed=1;
    }
    local sub
    for sub in bootstrap setup link install update remove new list help; do
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

CASE_TESTS+=(
  test_list_with_lock_custom_and_control
  test_list_without_lock
  test_list_invalid_lock
  test_list_rejects_extra_args
  test_help_content
  test_help_rejects_extra_args
)
