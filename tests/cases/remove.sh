# Test cases for `nexus remove`. Every assertion drives the CLI as a
# subprocess against an isolated fake HOME; the only seam is a fake `npx`.

remove_write_fake_npx() {
  local path="$1"
  mkdir -p -- "$(dirname -- "$path")"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$HOME/npx-args"
name=''
previous=''
for argument in "$@"; do
  if [[ "$previous" == remove ]]; then
    name="$argument"
    break
  fi
  previous="$argument"
done
case "${NEXUS_FAKE_NPX_MODE:-success}" in
  failure)
    exit 42
    ;;
  keep)
    # Upstream reports success but leaves the name in its lock.
    exit 0
    ;;
  leave_directory)
    # Upstream drops the lock entry but leaves the canonical directory.
    :
    ;;
  *)
    rm -rf -- "$HOME/.agents/skills/$name"
    ;;
esac
jq --arg name "$name" 'del(.skills[$name])' "$HOME/.agents/.skill-lock.json" \
  >"$HOME/.agents/.skill-lock.json.next"
mv -- "$HOME/.agents/.skill-lock.json.next" "$HOME/.agents/.skill-lock.json"
EOF
  chmod 755 "$path"
}

# A fake HOME with alpha and beta installed, both locks written, unrelated
# entries planted, and links already reconciled by a real `nexus link` run.
remove_installed_home() {
  local home canonical
  home="$(custom_home "$1")" || return 1
  canonical="$home/.agents/skills"
  write_skill "$canonical" alpha
  write_skill "$canonical" beta
  write_lock "$home/.agents/.skill-lock.json" alpha beta
  write_lock "$home/.nexus/skill-lock.json" alpha beta
  mkdir -p -- "$home/.claude/skills/unrelated" "$home/.codex/skills"
  printf 'preserve\n' >"$home/.claude/skills/unrelated/marker"
  ln -s -- /external/target "$home/.codex/skills/external"
  remove_write_fake_npx "$home/fakebin/npx"
  run_nexus "$home" link >/dev/null 2>&1 || return 1
  printf '%s\n' "$home"
}

# Run the CLI with a PATH and NVM_DIR that hold no npx at all, so a refusal
# that reaches upstream cannot be mistaken for a refusal that does not.
run_nexus_without_npx() {
  local home="$1"
  shift
  HOME="$home" NEXUS_HOME="$home/.nexus" PATH="/usr/bin:/bin" NVM_DIR="$home/.no-nvm" \
    "$REPO_ROOT/scripts/nexus" "$@"
}

test_remove_happy_path() {
  local failed=0 home output status args
  home="$(remove_installed_home remove_happy)" || { fail remove_happy_path; return; }

  output="$(PATH="$home/fakebin:$PATH" run_nexus "$home" remove alpha 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *'removed alpha:'* ]] || { printf '%s\n' "$output" >&2; failed=1; }

  args="$(cat "$home/npx-args")"
  [[ "$args" == *$'--yes\nskills\nremove\nalpha\n--global\n--yes'* ]] || { printf '  argv: %s\n' "$args" >&2; failed=1; }

  [[ ! -e "$home/.claude/skills/alpha" && ! -L "$home/.claude/skills/alpha" ]] || { printf '  Claude alpha link survived\n' >&2; failed=1; }
  [[ ! -e "$home/.codex/skills/alpha" && ! -L "$home/.codex/skills/alpha" ]] || { printf '  Codex alpha link survived\n' >&2; failed=1; }
  assert_link_to "$home/.claude/skills/beta" "$home/.agents/skills/beta" || failed=1
  assert_link_to "$home/.codex/skills/beta" "$home/.agents/skills/beta" || failed=1
  assert_link_to "$home/.claude/skills/nexus-remove" "$home/.nexus/skills/nexus-remove" || failed=1

  cmp -s "$home/.agents/.skill-lock.json" "$home/.nexus/skill-lock.json" || { printf '  published lock is not an exact upstream copy\n' >&2; failed=1; }
  grep -Fq '"alpha"' "$home/.nexus/skill-lock.json" && { printf '  alpha survived in the published lock\n' >&2; failed=1; }

  [[ -f "$home/.claude/skills/unrelated/marker" ]] || { printf '  unrelated physical entry was claimed\n' >&2; failed=1; }
  [[ "$(readlink -- "$home/.codex/skills/external")" == /external/target ]] || { printf '  external link was claimed\n' >&2; failed=1; }
  [[ -z "$(find "$home/.nexus" -maxdepth 1 \( -name '.nexus-install-*' -o -name '.nexus-lock.*' \) -print -quit)" ]] || { printf '  scratch residue retained\n' >&2; failed=1; }

  if (( failed == 0 )); then pass remove_happy_path; else fail remove_happy_path; fi
}

test_remove_refusals() {
  local failed=0 home lock_before lock_after output status
  home="$(remove_installed_home remove_refusals)" || { fail remove_refusals; return; }
  write_skill "$home/.custom-skills" mine
  rm -f -- "$home/npx-args"
  lock_before="$(sha256sum "$home/.nexus/skill-lock.json" | awk '{print $1}')"

  local -a expectations=(
    '2|remove requires exactly one skill name|'
    '2|remove requires exactly one skill name|alpha beta'
    '2|remove requires a safe skill name: --all|--all'
    '2|remove requires a safe skill name: ../escape|../escape'
    '2|reserved control skill name: nexus-link|nexus-link'
    '1|remove refuses a custom skill: mine|mine'
    '1|skill is not installed: ghost|ghost'
  )
  local expectation expected_status expected_text arguments
  for expectation in "${expectations[@]}"; do
    expected_status="${expectation%%|*}"
    expected_text="${expectation#*|}"
    arguments="${expected_text#*|}"
    expected_text="${expected_text%%|*}"
    # shellcheck disable=SC2086
    output="$(run_nexus_without_npx "$home" remove $arguments 2>&1)"; status=$?
    [[ "$status" -eq "$expected_status" ]] || { printf '  wrong status %s for [%s]\n%s\n' "$status" "$arguments" "$output" >&2; failed=1; }
    [[ "$output" == *"$expected_text"* ]] || { printf '  missing message for [%s]:\n%s\n' "$arguments" "$output" >&2; failed=1; }
    [[ "$output" != *npx* ]] || { printf '  refusal reached npx for [%s]\n' "$arguments" >&2; failed=1; }
  done

  [[ "$(cat "$home/.custom-skills/mine/SKILL.md")" == *'name: mine'* ]] || { printf '  custom skill was touched\n' >&2; failed=1; }
  [[ ! -e "$home/npx-args" ]] || { printf '  a refusal invoked npx\n' >&2; failed=1; }
  lock_after="$(sha256sum "$home/.nexus/skill-lock.json" | awk '{print $1}')"
  [[ "$lock_before" == "$lock_after" ]] || { printf '  a refusal changed the Nexus lock\n' >&2; failed=1; }
  if (( failed == 0 )); then pass remove_refusals; else fail remove_refusals; fi
}

test_remove_last_installed_skill() {
  local failed=0 home output status
  home="$(custom_home remove_last_skill)" || { fail remove_last_installed_skill; return; }
  write_skill "$home/.agents/skills" alpha
  write_lock "$home/.agents/.skill-lock.json" alpha
  write_lock "$home/.nexus/skill-lock.json" alpha
  remove_write_fake_npx "$home/fakebin/npx"
  run_nexus "$home" link >/dev/null 2>&1 || failed=1

  output="$(PATH="$home/fakebin:$PATH" run_nexus "$home" remove alpha 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  wrong status %s\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *'removed alpha:'* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$(jq -c .skills "$home/.nexus/skill-lock.json")" == '{}' ]] || failed=1
  [[ ! -e "$home/.claude/skills/alpha" && ! -e "$home/.codex/skills/alpha" ]] || failed=1
  assert_link_to "$home/.claude/skills/nexus-remove" "$home/.nexus/skills/nexus-remove" || failed=1
  if (( failed == 0 )); then pass remove_last_installed_skill; else fail remove_last_installed_skill; fi
}

test_remove_upstream_failure_keeps_lock() {
  local failed=0 home output status lock_before lock_after
  home="$(remove_installed_home remove_upstream_failure)" || { fail remove_upstream_failure_keeps_lock; return; }
  lock_before="$(sha256sum "$home/.nexus/skill-lock.json" | awk '{print $1}')"

  output="$(NEXUS_FAKE_NPX_MODE=failure PATH="$home/fakebin:$PATH" run_nexus "$home" remove alpha 2>&1)"; status=$?
  [[ "$status" -eq 42 ]] || { printf '  wrong status %s\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *'upstream skill removal failed (status 42)'* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  lock_after="$(sha256sum "$home/.nexus/skill-lock.json" | awk '{print $1}')"
  [[ "$lock_before" == "$lock_after" ]] || { printf '  upstream failure changed the Nexus lock\n' >&2; failed=1; }
  assert_link_to "$home/.claude/skills/alpha" "$home/.agents/skills/alpha" || failed=1
  assert_link_to "$home/.codex/skills/alpha" "$home/.agents/skills/alpha" || failed=1
  if (( failed == 0 )); then pass remove_upstream_failure_keeps_lock; else fail remove_upstream_failure_keeps_lock; fi
}

test_remove_refuses_name_still_in_upstream_lock() {
  local failed=0 home output status lock_before lock_after links_before links_after
  home="$(remove_installed_home remove_still_present)" || { fail remove_refuses_name_still_in_upstream_lock; return; }
  lock_before="$(sha256sum "$home/.nexus/skill-lock.json" | awk '{print $1}')"
  links_before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"

  output="$(NEXUS_FAKE_NPX_MODE=keep PATH="$home/fakebin:$PATH" run_nexus "$home" remove alpha 2>&1)"; status=$?
  [[ "$status" -eq 1 ]] || { printf '  wrong status %s\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *'upstream lock still contains alpha'* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  lock_after="$(sha256sum "$home/.nexus/skill-lock.json" | awk '{print $1}')"
  links_after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  [[ "$lock_before" == "$lock_after" ]] || { printf '  refused publication changed the Nexus lock\n' >&2; failed=1; }
  [[ "$links_before" == "$links_after" ]] || { printf '  refused publication changed the agent roots\n' >&2; failed=1; }
  [[ -z "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-install-*' -print -quit)" ]] || failed=1
  if (( failed == 0 )); then pass remove_refuses_name_still_in_upstream_lock; else fail remove_refuses_name_still_in_upstream_lock; fi
}

test_remove_reports_untracked_canonical_directory() {
  local failed=0 home output status
  home="$(remove_installed_home remove_untracked)" || { fail remove_reports_untracked_canonical_directory; return; }

  output="$(NEXUS_FAKE_NPX_MODE=leave_directory PATH="$home/fakebin:$PATH" run_nexus "$home" remove alpha 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  wrong status %s\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *"untracked canonical skill directory: $home/.agents/skills/alpha"* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ -d "$home/.agents/skills/alpha" ]] || { printf '  Nexus deleted canonical content\n' >&2; failed=1; }
  [[ ! -L "$home/.claude/skills/alpha" && ! -L "$home/.codex/skills/alpha" ]] || { printf '  alpha links survived\n' >&2; failed=1; }
  cmp -s "$home/.agents/.skill-lock.json" "$home/.nexus/skill-lock.json" || failed=1
  if (( failed == 0 )); then pass remove_reports_untracked_canonical_directory; else fail remove_reports_untracked_canonical_directory; fi
}

CASE_TESTS+=(
  test_remove_happy_path
  test_remove_refusals
  test_remove_last_installed_skill
  test_remove_upstream_failure_keeps_lock
  test_remove_refuses_name_still_in_upstream_lock
  test_remove_reports_untracked_canonical_directory
)
