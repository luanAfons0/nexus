# nexus update NAME. Every case drives the CLI as a subprocess against an
# isolated fake HOME, with a fake `npx` on PATH as the upstream seam.

update_fake_npx() {
  local dir="$1"
  mkdir -p -- "$dir"
  cat >"$dir/npx" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$HOME/npx-args"
case "${NEXUS_FAKE_NPX_MODE:-success}" in
  failure)
    exit 42 ;;
  drops_name)
    mkdir -p "$HOME/.agents/skills/beta"
    printf beta >"$HOME/.agents/skills/beta/SKILL.md"
    printf '%s\n' '{"version":3,"skills":{"beta":{"skillFolderHash":"hash-beta"}}}' >"$HOME/.agents/.skill-lock.json" ;;
  invalid_lock)
    mkdir -p "$HOME/.agents"
    printf '%s\n' '{bad' >"$HOME/.agents/.skill-lock.json" ;;
  missing_skill_md)
    rm -rf -- "$HOME/.agents/skills/alpha"
    printf '%s\n' '{"version":3,"skills":{"alpha":{"skillFolderHash":"hash-new"}}}' >"$HOME/.agents/.skill-lock.json" ;;
  *)
    mkdir -p "$HOME/.agents/skills/alpha"
    printf alpha >"$HOME/.agents/skills/alpha/SKILL.md"
    printf '%s\n' '{"version":3,"skills":{"alpha":{"skillFolderHash":"hash-new","updatedAt":"2026-02-02T00:00:00Z"}}}' >"$HOME/.agents/.skill-lock.json" ;;
esac
FAKE
  chmod 755 "$dir/npx"
}

test_update_happy_path() {
  local failed=0 home fake output status args
  home="$(custom_home update_happy)"
  fake="$home/fakebin"
  update_fake_npx "$fake"
  write_skill "$home/.agents/skills" alpha
  write_lock "$home/.nexus/skill-lock.json" alpha

  output="$(PATH="$fake:$PATH" run_nexus "$home" update alpha 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *'updated alpha: hash test-hash -> hash-new'* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *"canonical $home/.agents/skills/alpha"* ]] || failed=1
  [[ "$output" == *"Claude $home/.claude/skills/alpha"* ]] || failed=1
  [[ "$output" == *"Codex $home/.codex/skills/alpha"* ]] || failed=1

  args="$(cat "$home/npx-args")"
  [[ "$args" == *$'skills\nupdate\nalpha\n--global\n--yes'* ]] || { printf '  argv: %s\n' "$args" >&2; failed=1; }

  cmp -s "$home/.agents/.skill-lock.json" "$home/.nexus/skill-lock.json" || { printf '  published lock is not byte-identical\n' >&2; failed=1; }
  assert_link_to "$home/.claude/skills/alpha" "$home/.agents/skills/alpha" || failed=1
  assert_link_to "$home/.codex/skills/alpha" "$home/.agents/skills/alpha" || failed=1
  [[ -z "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-install-*' -print -quit)" ]] || failed=1

  # A repeated update with an unchanged hash still reports both sides.
  output="$(PATH="$fake:$PATH" run_nexus "$home" update alpha 2>&1)"; status=$?
  [[ "$status" -eq 0 && "$output" == *'updated alpha: hash hash-new -> hash-new'* ]] || { printf '%s\n' "$output" >&2; failed=1; }

  if (( failed == 0 )); then pass update_happy_path; else fail update_happy_path; fi
}

test_update_refusals() {
  local failed=0 home fake output status lock_before lock_after
  home="$(custom_home update_refusals)"
  fake="$home/fakebin"
  update_fake_npx "$fake"
  write_skill "$home/.agents/skills" alpha
  write_skill "$home/.custom-skills" mine
  write_lock "$home/.nexus/skill-lock.json" alpha
  lock_before="$(sha256sum "$home/.nexus/skill-lock.json")"

  # Usage refusals. The fake npx stays on PATH, so a recorded argv file would
  # prove the refusal came too late.
  output="$(PATH="$fake:$PATH" run_nexus "$home" update 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'update requires exactly one skill name'* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  output="$(PATH="$fake:$PATH" run_nexus "$home" update alpha beta 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'update requires exactly one skill name'* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  output="$(PATH="$fake:$PATH" run_nexus "$home" update --all 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'update requires a safe skill name'* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  output="$(PATH="$fake:$PATH" run_nexus "$home" update ../x 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'update requires a safe skill name'* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  output="$(PATH="$fake:$PATH" run_nexus "$home" update nexus-link 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'reserved control skill name: nexus-link'* ]] || { printf '%s\n' "$output" >&2; failed=1; }

  # Ownership refusals.
  output="$(PATH="$fake:$PATH" run_nexus "$home" update mine 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *"update refuses a custom skill: mine ($home/.custom-skills/mine); pull it in the custom root and run link"* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  output="$(PATH="$fake:$PATH" run_nexus "$home" update gamma 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'skill is not installed: gamma'* ]] || { printf '%s\n' "$output" >&2; failed=1; }

  [[ ! -e "$home/npx-args" ]] || { printf '  a refusal reached upstream npx\n' >&2; failed=1; }
  lock_after="$(sha256sum "$home/.nexus/skill-lock.json")"
  [[ "$lock_before" == "$lock_after" ]] || { printf '  a refusal changed the Nexus lock\n' >&2; failed=1; }

  # PATH without npx proves the refusals precede the npx check as well.
  output="$(HOME="$home" NEXUS_HOME="$home/.nexus" PATH="/usr/bin:/bin" NVM_DIR="$home/.no-nvm" \
    "$REPO_ROOT/scripts/nexus" update mine 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'update refuses a custom skill: mine'* && "$output" != *npx* ]] || { printf '%s\n' "$output" >&2; failed=1; }

  if (( failed == 0 )); then pass update_refusals; else fail update_refusals; fi
}

test_update_failure_modes() {
  local failed=0 home fake output status mode lock_before lock_after upstream_before

  # Upstream failure keeps the Nexus lock and reports the upstream status.
  home="$(custom_home update_upstream_failure)"
  fake="$home/fakebin"
  update_fake_npx "$fake"
  write_skill "$home/.agents/skills" alpha
  write_lock "$home/.nexus/skill-lock.json" alpha
  lock_before="$(sha256sum "$home/.nexus/skill-lock.json")"
  output="$(NEXUS_FAKE_NPX_MODE=failure PATH="$fake:$PATH" run_nexus "$home" update alpha 2>&1)"; status=$?
  [[ "$status" -eq 42 && "$output" == *'upstream skill update failed (status 42)'* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  lock_after="$(sha256sum "$home/.nexus/skill-lock.json")"
  [[ "$lock_before" == "$lock_after" ]] || failed=1

  # An upstream lock that lost the skill, an invalid upstream lock, and a
  # missing canonical SKILL.md all refuse publication.
  for mode in drops_name invalid_lock missing_skill_md; do
    home="$(custom_home "update_$mode")"
    fake="$home/fakebin"
    update_fake_npx "$fake"
    write_skill "$home/.agents/skills" alpha
    write_lock "$home/.nexus/skill-lock.json" alpha
    write_lock "$home/.agents/.skill-lock.json" alpha
    lock_before="$(sha256sum "$home/.nexus/skill-lock.json")"
    output="$(NEXUS_FAKE_NPX_MODE="$mode" PATH="$fake:$PATH" run_nexus "$home" update alpha 2>&1)"; status=$?
    [[ "$status" -eq 1 ]] || { printf '  %s: status %s\n%s\n' "$mode" "$status" "$output" >&2; failed=1; }
    case "$mode" in
      drops_name) [[ "$output" == *'upstream lock no longer contains alpha'* ]] || { printf '%s\n' "$output" >&2; failed=1; } ;;
      invalid_lock) [[ "$output" == *'upstream did not produce a valid version-3 skill lock'* ]] || { printf '%s\n' "$output" >&2; failed=1; } ;;
      missing_skill_md) [[ "$output" == *"upstream lock skill is missing SKILL.md: $home/.agents/skills/alpha/SKILL.md"* ]] || { printf '%s\n' "$output" >&2; failed=1; } ;;
    esac
    [[ "$output" != *'updated alpha'* ]] || failed=1
    lock_after="$(sha256sum "$home/.nexus/skill-lock.json")"
    [[ "$lock_before" == "$lock_after" ]] || { printf '  %s: the Nexus lock changed\n' "$mode" >&2; failed=1; }
    [[ -z "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-install-*' -print -quit)" ]] || { printf '  %s: snapshot residue retained\n' "$mode" >&2; failed=1; }
  done

  if (( failed == 0 )); then pass update_failure_modes; else fail update_failure_modes; fi
}

CASE_TESTS+=(test_update_happy_path test_update_refusals test_update_failure_modes)
