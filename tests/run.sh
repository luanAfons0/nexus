#!/usr/bin/env bash
set -uo pipefail

export NEXUS_TEST_MODE=1

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
  mkdir -p "$home/.nexus" || return 1
  : >"$home/.nexus-test-home" || return 1
  cp -R -- "$REPO_ROOT/skills" "$home/.nexus/" || return 1
  printf '%s\n' "$home"
}

run_nexus_overridden() {
  local home="$1" fault="$2"; shift 2
  local resolved
  resolved="$(realpath -e -- "$home")" || return 125
  [[ "$resolved" == "$(realpath -e -- "$TEST_ROOT")"/* && -f "$resolved/.nexus-test-home" ]] || {
    printf 'refusing test override outside validated fake home\n' >&2; return 125;
  }
  HOME="$resolved" NEXUS_HOME="$resolved/.nexus" NEXUS_FAULT="$fault" \
    bash -c 'source "$1"; nexus_init; source "$2"; fault_setup; if [[ "$3" == put_link_force ]]; then put_link "${4}" "${5}" true; else main "${@:3}"; fi' \
      bash "$REPO_ROOT/scripts/nexus" "$REPO_ROOT/tests/faults.sh" "$@"
}

start_nexus_overridden() {
  local home="$1" fault="$2" output="$3"; shift 3
  local resolved
  resolved="$(realpath -e -- "$home")" || return 125
  [[ "$resolved" == "$(realpath -e -- "$TEST_ROOT")"/* && -f "$resolved/.nexus-test-home" ]] || {
    printf 'refusing test override outside validated fake home\n' >&2; return 125;
  }
  HOME="$resolved" NEXUS_HOME="$resolved/.nexus" NEXUS_FAULT="$fault" \
    bash -c 'export NEXUS_FAULT="$3"; source "$1"; nexus_init; source "$2"; fault_setup; if [[ "$4" == put_link_force ]]; then put_link "${5}" "${6}" true; else main "${@:4}"; fi' \
      bash "$REPO_ROOT/scripts/nexus" "$REPO_ROOT/tests/faults.sh" "$fault" "$@" >"$output" 2>&1 &
  NEXUS_TEST_PID=$!
}

wait_handshake() {
  local marker="$1" pid="$2" i
  for i in {1..200}; do
    [[ -e "$marker" ]] && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep .02
  done
  return 1
}

stop_and_reap() {
  local pid="$1" status
  kill -TERM "$pid" 2>/dev/null || :
  for _ in {1..100}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep .02
  done
  wait "$pid" 2>/dev/null; status=$?
  NEXUS_WAIT_STATUS="$status"
}

run_nexus() {
  local home="$1"
  shift
  HOME="$home" NEXUS_HOME="$home/.nexus" "$REPO_ROOT/scripts/nexus" "$@"
}

run_put_link_force() {
  local home="$1" target="$2" link="$3"
  HOME="$home" NEXUS_HOME="$home/.nexus" bash -c \
    'source "$1"; nexus_init; put_link "$2" "$3" true' bash "$REPO_ROOT/scripts/lib/common.sh" "$target" "$link"
}

test_source_hygiene() {
  local failed=0 home before after output
  home="$(new_home source_hygiene)"
  before="$(snapshot_tree "$home")"
  output="$(HOME="$home" NEXUS_HOME="$home/.nexus" bash -c '
    set +e +u +o pipefail
    shopt -s nullglob
    trap ":" USR1
    before_flags="$-"
    before_pipefail="$(set -o | awk '\''$1 == "pipefail" { print $2 }'\'')"
    before_shopt="$(shopt -p nullglob)"
    before_trap="$(trap -p USR1)"
    source "$1"
    after_flags="$-"
    after_pipefail="$(set -o | awk '\''$1 == "pipefail" { print $2 }'\'')"
    after_shopt="$(shopt -p nullglob)"
    after_trap="$(trap -p USR1)"
    [[ "$before_flags" == "$after_flags" &&
       "$before_pipefail" == "$after_pipefail" &&
       "$before_shopt" == "$after_shopt" &&
       "$before_trap" == "$after_trap" ]]
  ' bash "$REPO_ROOT/scripts/nexus" 2>&1)" || failed=1
  after="$(snapshot_tree "$home")"
  [[ -z "$output" ]] || { printf '  sourcing emitted output:\n%s\n' "$output" >&2; failed=1; }
  [[ "$before" == "$after" ]] || { printf '  sourcing mutated fake HOME\n' >&2; failed=1; }
  if (( failed == 0 )); then pass source_hygiene; else fail source_hygiene; fi
}

test_shell_syntax() {
  local failed=0 file
  while IFS= read -r file; do
    bash -n -- "$file" || failed=1
  done < <(printf '%s\n' "$REPO_ROOT/scripts/nexus" "$REPO_ROOT"/scripts/lib/*.sh "$REPO_ROOT"/tests/*.sh "$REPO_ROOT"/tests/cases/*.sh)
  while IFS= read -r file; do
    python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' "$file" || failed=1
  done < <(printf '%s\n' "$REPO_ROOT"/scripts/lib/*.py "$REPO_ROOT"/tests/*.py)
  if (( failed == 0 )); then pass shell_syntax; else fail shell_syntax; fi
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
    local listing
    listing="$(mktemp)" || return 1
    find "$root" -mindepth 1 -printf '%y|%P|%l\n' >"$listing" || { rm -f -- "$listing"; return 1; }
    LC_ALL=C sort -- "$listing"
    local status=$?
    rm -f -- "$listing"
    return "$status"
  fi
}

test_bootstrap() {
  local failed=0 home output before after name command link target
  home="$(new_home bootstrap)"
  output="$(run_nexus "$home" bootstrap 2>&1)" || { printf '%s\n' "$output" >&2; failed=1; }

  for name in nexus-setup nexus-link nexus-install nexus-new nexus-help nexus-update nexus-remove nexus; do
    link="$home/.claude/skills/$name"; target="$home/.nexus/skills/$name"
    assert_link_to "$link" "$target" || failed=1
    [[ "$(readlink -- "$link")" != /* ]] || { printf '  absolute Claude link: %s\n' "$link" >&2; failed=1; }
    link="$home/.codex/skills/$name"
    assert_link_to "$link" "$target" || failed=1
    [[ "$(readlink -- "$link")" != /* ]] || { printf '  absolute Codex link: %s\n' "$link" >&2; failed=1; }
  done
  [[ ! -e "$home/.claude/commands/nexus" ]] || { printf '  unexpected command adapters\n' >&2; failed=1; }
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
  output="$(run_nexus_overridden "$home" stage bootstrap 2>&1)" && failed=1
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
  output="$(run_nexus_overridden "$home" promote put_link_force "$home/.nexus/skills/nexus-setup" "$link" 2>&1)" && failed=1
  [[ -f "$link/marker" && "$(cat "$link/marker")" == restore-me ]] || failed=1
  [[ -z "$(find "$home/.claude/skills" -maxdepth 1 -type d -name '.nexus-backup.*' -print -quit)" ]] || failed=1
  [[ -z "$(find "$home/.claude/skills" -maxdepth 1 -name '.nexus-tmp.*' -print -quit)" ]] || failed=1

  home="$(new_home force_verify_failure)"
  link="$home/.claude/skills/nexus-setup"
  mkdir -p "$link"
  printf 'verify-me\n' >"$link/marker"
  output="$(run_nexus_overridden "$home" verify put_link_force "$home/.nexus/skills/nexus-setup" "$link" 2>&1)" && failed=1
  [[ -f "$link/marker" && "$(cat "$link/marker")" == verify-me ]] || failed=1
  [[ -z "$(find "$home/.claude/skills" -maxdepth 1 \( -name '.nexus-tmp.*' -o -name '.nexus-backup.*' \) -print -quit)" ]] || failed=1

  home="$(new_home force_restore_failure)"
  link="$home/.claude/skills/nexus-setup"
  mkdir -p "$link"
  printf 'retain-me\n' >"$link/marker"
  output="$(run_nexus_overridden "$home" restore put_link_force "$home/.nexus/skills/nexus-setup" "$link" 2>&1)" && failed=1
  backup="$(printf '%s\n' "$output" | sed -n 's/.*recovery container retained: //p' | tail -n 1)"
  [[ -n "$backup" && -f "$backup/original/marker" ]] || failed=1
  [[ "$(cat "$backup/original/marker" 2>/dev/null)" == retain-me ]] || failed=1
  if (( failed == 0 )); then pass force_recovery; else fail force_recovery; fi
}

test_install_cli_and_nvm_fallback() {
  local failed=0 home output args fake
  home="$(new_home install_cli)"
  fake="$home/fakebin"
  mkdir -p "$fake"
  cat >"$fake/npx" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$HOME/npx-args"
if [[ "${NEXUS_FAKE_NPX_MODE:-success}" == failure ]]; then
  mkdir -p "$HOME/.agents/skills/alpha"
  printf untracked >"$HOME/.agents/skills/alpha/marker"
  exit 42
fi
mkdir -p "$HOME/.agents/skills/alpha" "$HOME/.agents/skills/beta"
printf alpha >"$HOME/.agents/skills/alpha/SKILL.md"
printf beta >"$HOME/.agents/skills/beta/SKILL.md"
printf '%s\n' '{"version":3,"skills":{"alpha":{},"beta":{}}}' >"$HOME/.agents/.skill-lock.json"
EOF
  chmod 755 "$fake/npx"
  output="$(PATH="$fake:$PATH" run_nexus "$home" install source --skill alpha --skill beta 2>&1)" || failed=1
  args="$(cat "$home/npx-args")"
  [[ "$args" == *$'--yes\nskills\nadd\nsource\n--global\n--agent\nuniversal\n--skill\nalpha\n--skill\nbeta\n--yes'* ]] || failed=1
  cmp -s "$home/.agents/.skill-lock.json" "$home/.nexus/skill-lock.json" || failed=1
  assert_link_to "$home/.claude/skills/alpha" "$home/.agents/skills/alpha" || failed=1
  assert_link_to "$home/.codex/skills/beta" "$home/.agents/skills/beta" || failed=1

  home="$(new_home install_failure)"
  mkdir -p "$home/.nexus"; printf original >"$home/.nexus/skill-lock.json"
  output="$(NEXUS_FAKE_NPX_MODE=failure PATH="$fake:$PATH" run_nexus "$home" install source --skill alpha 2>&1)"; [[ "$?" -eq 42 ]] || failed=1
  [[ "$output" == *'untracked canonical skill directory'* && "$(cat "$home/.nexus/skill-lock.json")" == original ]] || failed=1

  home="$(new_home install_rejects_option_source)"
  mkdir -p "$home/fakebin"
  printf '%s\n' '#!/usr/bin/env bash' 'printf invoked >"$HOME/npx-invoked"' >"$home/fakebin/npx"
  chmod 755 "$home/fakebin/npx"
  output="$(PATH="$home/fakebin:$PATH" run_nexus "$home" install -bogus --skill alpha 2>&1)"; [[ "$?" -eq 2 ]] || failed=1
  [[ "$output" == *'unknown install flag: -bogus'* && ! -e "$home/npx-invoked" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1

  home="$(new_home install_snapshot)"
  mkdir -p "$home/.agents/skills/alpha" "$home/.agents/skills/beta" "$home/fakebin"
  printf alpha >"$home/.agents/skills/alpha/SKILL.md"
  printf beta >"$home/.agents/skills/beta/SKILL.md"
  printf '%s\n' '#!/usr/bin/env bash' 'mkdir -p "$HOME/.agents/skills/alpha"' 'printf '\''{"version":3,"skills":{"alpha":{}}}\n'\'' >"$HOME/.agents/.skill-lock.json"' >"$home/fakebin/npx"
  chmod 755 "$home/fakebin/npx"
  output="$(PATH="$home/fakebin:$PATH" run_nexus_overridden "$home" install_snapshot_mutate install source --skill alpha 2>&1)" || failed=1
  cmp -s "$home/.nexus/skill-lock.json" <(printf '%s\n' '{"version":3,"skills":{"alpha":{}}}') || failed=1
  [[ ! -e "$home/.agents/.skill-lock.json" || "$(cat "$home/.agents/.skill-lock.json")" == *'beta'* ]] || failed=1
  [[ -z "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-install-*' -print -quit)" ]] || failed=1

  home="$(new_home install_cleanup)"
  mkdir -p "$home/fakebin"
  printf '%s\n' '#!/usr/bin/env bash' 'mkdir -p "$HOME/.agents"' 'printf '\''{bad\n'\'' >"$HOME/.agents/.skill-lock.json"' >"$home/fakebin/npx"
  chmod 755 "$home/fakebin/npx"
  output="$(PATH="$home/fakebin:$PATH" run_nexus_overridden "$home" install_cleanup_fail install source --skill alpha 2>&1)" || :
  [[ "$output" == *'install scratch retained:'* ]] || failed=1
  [[ -n "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-install-*' -print -quit)" ]] || failed=1

  home="$(new_home install_nvm)"
  unset NVM_DIR
  mkdir -p "$home/.nvm" "$home/nvm-bin" "$home/onlybin"
  for command in /usr/bin/*; do
    [[ "$(basename -- "$command")" == npx ]] && continue
    ln -s -- "$command" "$home/onlybin/$(basename -- "$command")" 2>/dev/null || :
  done
  unlink "$home/onlybin/npx" 2>/dev/null || :
  cp -- "$fake/npx" "$home/nvm-bin/npx"
  cat >"$home/.nvm/nvm.sh" <<'EOF'
nvm() { PATH="$HOME/nvm-bin:$PATH"; export PATH; }
EOF
  PATH="$home/onlybin"; export PATH
  output="$(run_nexus "$home" install source --skill alpha 2>&1)" || failed=1
  [[ "$output" == *'installed alpha'* ]] || failed=1
  if (( failed == 0 )); then pass install_cli_and_nvm_fallback; else fail install_cli_and_nvm_fallback; fi
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
  [[ "$status" -eq 2 && "$output" == *'install requires one source'* ]] || failed=1
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

  for case in missing malformed version skills_object invalid_then_valid valid_then_another nexus-setup '' '.' '..' 'bad/name' '../escape' '-bad' '_bad' $'line\nbreak' $'tab\tkey' $'trailing\n'; do
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
      nexus-setup)
        jq -n '{version: 3, skills: {"nexus-setup": {}}}' >"$lock"
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
  for name in alpha beta nexus-setup nexus-link nexus-install nexus-new nexus-help nexus-update nexus-remove nexus; do
    if [[ "$name" == nexus-* || "$name" == nexus ]]; then
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
  output="$(run_nexus_overridden "$home" lock_extract link 2>&1)"; status=$?
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  [[ "$status" -ne 0 && "$output" == *'lock key extraction failed'* && "$before" == "$after" ]] || failed=1
  [[ -z "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-lock.*' -print -quit)" ]] || failed=1

  output="$(run_nexus_overridden "$home" lock_replace link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  assert_link_to "$home/.claude/skills/alpha" "$canonical/alpha" || failed=1
  assert_link_to "$home/.codex/skills/alpha" "$canonical/alpha" || failed=1
  [[ ! -L "$home/.claude/skills/stale" && ! -L "$home/.codex/skills/stale" ]] || failed=1
  [[ ! -e "$home/.claude/escape" && ! -e "$home/.codex/escape" && ! -e "$home/.agents/escape" ]] || failed=1
  [[ -z "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-lock.*' -print -quit)" ]] || failed=1
  if (( failed == 0 )); then pass link_snapshot_safety; else fail link_snapshot_safety; fi
}

custom_home() {
  local home
  home="$(new_home "$1")"
  mkdir -p "$home/.custom-skills" "$home/.claude/skills" "$home/.codex/skills" "$home/.agents/skills"
  printf '%s\n' "$home"
}

assert_link_unchanged() {
  local home="$1" before="$2" after
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.agents")"
  [[ "$before" == "$after" ]] && return 0
  printf '  agent trees were mutated by a failed reconcile\n' >&2
  return 1
}

test_custom_link_reconciliation() {
  local failed=0 home custom canonical output status name
  home="$(custom_home custom_link)"
  custom="$home/.custom-skills"
  canonical="$home/.agents/skills"
  write_skill "$canonical" installed
  write_skill "$custom" mine
  write_skill "$custom" other
  write_lock "$home/.nexus/skill-lock.json" installed

  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  for name in mine other; do
    assert_link_to "$home/.claude/skills/$name" "$custom/$name" || failed=1
    assert_link_to "$home/.codex/skills/$name" "$custom/$name" || failed=1
    [[ "$(readlink -- "$home/.claude/skills/$name")" != /* ]] || { printf '  absolute custom link: %s\n' "$name" >&2; failed=1; }
  done
  assert_link_to "$home/.claude/skills/installed" "$canonical/installed" || failed=1
  assert_link_to "$home/.codex/skills/nexus-new" "$home/.nexus/skills/nexus-new" || failed=1

  # A custom skill removed from the root loses its managed links.
  rm -rf -- "$custom/other"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ ! -e "$home/.claude/skills/other" && ! -e "$home/.codex/skills/other" ]] || failed=1
  assert_link_to "$home/.claude/skills/mine" "$custom/mine" || failed=1

  # An absent custom root is not an error: it simply means no custom skills.
  rm -rf -- "$custom"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 && "$output" != *error* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ ! -e "$home/.claude/skills/mine" ]] || failed=1
  if (( failed == 0 )); then pass custom_link_reconciliation; else fail custom_link_reconciliation; fi
}

test_custom_root_validation() {
  local failed=0 home custom output status before
  home="$(custom_home custom_validation)"
  custom="$home/.custom-skills"
  write_skill "$home/.agents/skills" installed
  write_lock "$home/.nexus/skill-lock.json" installed
  write_skill "$custom" mine

  # Repository furniture is skipped, not linked and not reported.
  mkdir -p "$custom/.git" "$custom/.workspaces/mine"
  printf 'notes\n' >"$custom/README.md"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ ! -e "$home/.claude/skills/.git" && ! -e "$home/.claude/skills/.workspaces" && ! -e "$home/.claude/skills/README.md" ]] || failed=1

  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.agents")"

  # A directory without SKILL.md is a hard error, and nothing is mutated.
  mkdir -p "$custom/mine-workspace"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -ne 0 && "$output" == *'missing SKILL.md'* && "$output" == *'no changes were made'* ]] || failed=1
  assert_link_unchanged "$home" "$before" || failed=1
  rmdir "$custom/mine-workspace"

  # A symlinked entry is refused: the owner root holds physical content only.
  ln -s -- "$home/.agents/skills/installed" "$custom/aliased"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -ne 0 && "$output" == *'must not be a symlink'* ]] || failed=1
  assert_link_unchanged "$home" "$before" || failed=1
  rm -- "$custom/aliased"

  # A symlinked custom root is refused.
  mv -- "$custom" "$home/.custom-real"
  ln -s -- "$home/.custom-real" "$custom"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -ne 0 && "$output" == *'must be a physical directory'* ]] || failed=1
  assert_link_unchanged "$home" "$before" || failed=1
  rm -- "$custom"; mv -- "$home/.custom-real" "$custom"

  # A reserved control name inside the custom root is refused.
  write_skill "$custom" nexus-link
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -ne 0 && "$output" == *'reserved control skill name'* ]] || failed=1
  assert_link_unchanged "$home" "$before" || failed=1
  if (( failed == 0 )); then pass custom_root_validation; else fail custom_root_validation; fi
}

test_custom_collision_and_canonical_forbidden() {
  local failed=0 home custom canonical output status before
  home="$(custom_home custom_collision)"
  custom="$home/.custom-skills"
  canonical="$home/.agents/skills"
  write_skill "$canonical" installed
  write_lock "$home/.nexus/skill-lock.json" installed
  write_skill "$custom" mine
  run_nexus "$home" link >/dev/null 2>&1 || failed=1
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.agents")"

  # A custom skill may not shadow an installed one.
  write_skill "$custom" installed
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -ne 0 && "$output" == *'collides with an installed skill: installed'* &&
     "$output" == *'no changes were made'* ]] || failed=1
  assert_link_unchanged "$home" "$before" || failed=1
  rm -rf -- "$custom/installed"

  # A custom skill may not be reachable through the canonical root.
  ln -s -- "$custom/mine" "$canonical/mine"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -ne 0 && "$output" == *'custom skill link in canonical root'* ]] || failed=1
  rm -- "$canonical/mine"
  output="$(run_nexus "$home" link 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  if (( failed == 0 )); then pass custom_collision_and_canonical_forbidden; else fail custom_collision_and_canonical_forbidden; fi
}

test_new_cli() {
  local failed=0 home custom output status reserved
  home="$(custom_home new_cli)"
  custom="$home/.custom-skills"
  write_skill "$home/.agents/skills" installed
  write_lock "$home/.nexus/skill-lock.json" installed

  output="$(run_nexus "$home" new 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'exactly one skill name'* ]] || failed=1
  output="$(run_nexus "$home" new a b 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'exactly one skill name'* ]] || failed=1
  output="$(run_nexus "$home" new '../escape' 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'safe skill name'* ]] || failed=1
  output="$(run_nexus "$home" new '--flag' 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'safe skill name'* ]] || failed=1
  output="$(run_nexus "$home" new nexus-link 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'reserved control skill name'* ]] || failed=1
  for reserved in nexus-help nexus-update nexus-remove nexus; do
    output="$(run_nexus "$home" new "$reserved" 2>&1)"; status=$?
    [[ "$status" -eq 2 && "$output" == *'reserved control skill name'* ]] || failed=1
  done
  output="$(run_nexus "$home" new installed 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'collides with an installed skill'* ]] || failed=1
  [[ ! -e "$custom/installed" ]] || failed=1

  output="$(run_nexus "$home" new mine 2>&1)"; status=$?
  [[ "$status" -eq 0 && "$output" == *"created mine: $custom/mine"* &&
     "$output" == *"workspace mine: $custom/.workspaces/mine"* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ -d "$custom/mine" && ! -e "$custom/mine/SKILL.md" ]] || failed=1
  [[ -z "$(find "$custom/mine" -mindepth 1 -print -quit)" ]] || failed=1

  output="$(run_nexus "$home" new mine 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'already exists'* ]] || failed=1

  # Without a custom root the command refuses instead of creating one.
  rm -rf -- "$custom/mine" "$custom"
  output="$(run_nexus "$home" new mine 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'does not exist'* && ! -e "$custom" ]] || failed=1
  if (( failed == 0 )); then pass new_cli; else fail new_cli; fi
}

test_install_rejects_custom_collision() {
  local failed=0 home output status lock_before lock_after reserved
  home="$(custom_home install_custom_collision)"
  write_skill "$home/.custom-skills" mine
  write_lock "$home/.nexus/skill-lock.json"
  lock_before="$(sha256sum "$home/.nexus/skill-lock.json")"

  # PATH without npx proves the refusal happens before the network call.
  output="$(HOME="$home" NEXUS_HOME="$home/.nexus" PATH="/usr/bin:/bin" NVM_DIR="$home/.no-nvm" \
    "$REPO_ROOT/scripts/nexus" install /some/source --skill mine 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'collides with a custom skill: mine'* ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$output" != *npx* ]] || failed=1
  for reserved in nexus-new nexus-help nexus-update nexus-remove nexus; do
    output="$(run_nexus "$home" install /some/source --skill "$reserved" 2>&1)"; status=$?
    [[ "$status" -eq 2 && "$output" == *'non-control skill name'* ]] || failed=1
  done
  lock_after="$(sha256sum "$home/.nexus/skill-lock.json")"
  [[ "$lock_before" == "$lock_after" ]] || failed=1
  if (( failed == 0 )); then pass install_rejects_custom_collision; else fail install_rejects_custom_collision; fi
}

assert_no_setup_residue() {
  local home="$1"
  [[ -z "$(find "$home" -maxdepth 3 \( -name '.nexus-lock.*' -o -name '.nexus-setup-backup.*' -o -name '.nexus-setup-lock.*' -o -name '.nexus-setup-source.*' -o -name '.nexus-setup-copy.*' -o -name '.nexus-canonical-tmp.*' -o -name '.nexus-canonical-old.*' \) -print -quit)" ]]
}

test_setup_happy_and_idempotent() {
  local failed=0 home source output before after mode newline_hash
  home="$(new_home setup_happy)"
  source="$home/.agents/.skill-lock.json"
  write_lock "$source" alpha beta
  mkdir -p "$home/.claude/skills/alpha" "$home/.codex/skills/.system"
  printf 'hidden\n' >"$home/.claude/.hidden"
  printf 'executable\n' >"$home/.claude/run-me"; chmod 751 "$home/.claude/run-me"
  ln -s -- /ordinary/link "$home/.claude/ordinary-link"
  ln -s -- $'literal-target\n' "$home/.claude/trailing-newline-link"
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
  newline_hash="$(readlink -n -- "$home/.claude/trailing-newline-link" | sha256sum | awk '{print $1}')"
  [[ -L "$home/.claude-backup/trailing-newline-link" && "$newline_hash" == "$(readlink -n -- "$home/.claude-backup/trailing-newline-link" | sha256sum | awk '{print $1}')" ]] || failed=1
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
  [[ "$output" == *'third-party skills: 2'* && "$output" == *'linked agent skill entries: 20'* ]] || failed=1
  assert_no_setup_residue "$home" || failed=1
  before="$(snapshot_tree "$home/.nexus")|$(snapshot_tree "$home/.agents")|$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.claude-backup")|$(snapshot_tree "$home/.codex-backup")"
  output="$(run_nexus "$home" setup 2>&1)" || failed=1
  after="$(snapshot_tree "$home/.nexus")|$(snapshot_tree "$home/.agents")|$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.claude-backup")|$(snapshot_tree "$home/.codex-backup")"
  [[ "$output" == *'already initialized'* && "$output" == *'/nexus-link'* && "$output" == *'$nexus-link'* && "$before" == "$after" ]] || failed=1
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

  home="$(new_home setup_mutex)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.nexus/.nexus-setup.lock"
  before="$(snapshot_tree "$home")"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  after="$(snapshot_tree "$home")"
  [[ "$output" == *'another setup is already running'* && "$before" == "$after" && ! -e "$home/.claude-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1

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
  output="$(run_nexus_overridden "$home" backup_copy_fail setup 2>&1)" && failed=1
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  [[ "$before" == "$after" && ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" && "$source_hash" == "$(sha256sum "$home/.agents/.skill-lock.json")" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_backup_false_success)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  printf 'hidden-original\n' >"$home/.claude/.hidden"
  ln -s -- /external/ordinary "$home/.claude/ordinary-link"
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  output="$(run_nexus_overridden "$home" backup_copy_false setup 2>&1)" && failed=1
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  [[ ( "$output" == *'backup verification failed'* || "$output" == *'agent state changed during backup'* ) && "$before" == "$after" && ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_backup_corrupt_success)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  printf 'hidden-original\n' >"$home/.claude/.hidden"; chmod 644 "$home/.claude/.hidden"
  seam="$home/backup-corrupt-seam"
  printf '%s\n' '#!/usr/bin/env bash' 'command cp "$@"' 'destination="${!#}"' 'chmod 600 "$destination/.hidden"' >"$seam"; chmod 755 "$seam"
  output="$(run_nexus_overridden "$home" backup_copy_corrupt setup 2>&1)" && failed=1
  [[ ( "$output" == *'backup verification failed'* || "$output" == *'agent state changed during backup'* ) && ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_backup_root_metadata_false_success)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  printf 'same-child\n' >"$home/.claude/child"
  chmod 751 "$home/.claude"; touch -d '2026-01-01 00:00:00.123456789' "$home/.claude"
  output="$(run_nexus_overridden "$home" backup_root_corrupt setup 2>&1)" && failed=1
  [[ ( "$output" == *'backup verification failed'* || "$output" == *'agent state changed during backup'* ) && ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_backup_child_subsecond_false_success)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  printf 'same-child\n' >"$home/.claude/child"
  touch -d '2026-01-01 00:00:00.123456789' "$home/.claude/child"
  seam="$home/backup-child-metadata-seam"
  printf '%s\n' '#!/usr/bin/env bash' 'command cp "$@"' 'destination="${!#}"' 'touch -d "2026-01-01 00:00:00.987654321" "$destination/child"' >"$seam"; chmod 755 "$seam"
  output="$(run_nexus_overridden "$home" backup_child_corrupt setup 2>&1)" && failed=1
  [[ ( "$output" == *'backup verification failed'* || "$output" == *'agent state changed during backup'* ) && ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_backup_trailing_newline_symlink_corrupt)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  ln -s -- $'literal-target\n' "$home/.claude/trailing-newline-link"
  seam="$home/backup-symlink-corrupt-seam"
  printf '%s\n' '#!/usr/bin/env bash' 'command cp "$@"' 'destination="${!#}"' 'rm -- "$destination/trailing-newline-link"' 'ln -s -- literal-target "$destination/trailing-newline-link"' >"$seam"; chmod 755 "$seam"
  output="$(run_nexus_overridden "$home" backup_symlink_corrupt setup 2>&1)" && failed=1
  [[ ( "$output" == *'backup verification failed'* || "$output" == *'agent state changed during backup'* ) && ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_backup_promotion_identity)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  output="$(run_nexus_overridden "$home" backup_promote_ambiguous setup 2>&1)" && failed=1
  [[ "$output" == *'backup promotion changed verified tree identity'* && -d "$home/.claude-backup" && -d "$home/.codex-backup" && -d "$home/.claude-backup.unknown" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  home="$(new_home setup_promotion_failure)"
  write_lock "$home/.agents/.skill-lock.json"
  output="$(run_nexus_overridden "$home" backup_promote_second setup 2>&1)" && failed=1
  [[ ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_rollback_recovery)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  printf 'claude-original\n' >"$home/.claude/marker"; printf 'codex-original\n' >"$home/.codex/marker"
  output="$(run_nexus_overridden "$home" backup_rollback setup 2>&1)" && failed=1
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

test_setup_backup_retries_and_manifest_bound() {
  local failed=0 home output before after
  home="$(new_home setup_backup_retry_once)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  printf 'initial\n' >"$home/.claude/retry-marker"
  output="$(run_nexus_overridden "$home" backup_retry_once setup 2>&1)" || failed=1
  [[ -f "$home/.claude-backup/retry-marker" && "$(cat "$home/.claude-backup/retry-marker")" == *retry-state* ]] || failed=1

  home="$(new_home setup_backup_retry_always)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  printf 'live\n' >"$home/.claude/retry-marker"; printf 'live\n' >"$home/.codex/retry-marker"
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  output="$(run_nexus_overridden "$home" backup_retry_always setup 2>&1)" && failed=1
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")"
  [[ "$output" == *'agent state changed during backup; close Claude and Codex and retry'* && -f "$home/.claude/retry-marker" && -f "$home/.codex/retry-marker" && ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_backup_manifest_bound)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  run_nexus_overridden "$home" backup_manifest_count setup >/dev/null 2>&1 || failed=1
  [[ "$(wc -l <"$home/manifest-calls")" == 6 ]] || failed=1
  home="$(new_home setup_backup_manifest_bound_absent)"
  write_lock "$home/.agents/.skill-lock.json"
  run_nexus_overridden "$home" backup_manifest_count setup >/dev/null 2>&1 || failed=1
  [[ "$(wc -l <"$home/manifest-calls")" == 6 && -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1
  if (( failed == 0 )); then pass setup_backup_retries_and_manifest_bound; else fail setup_backup_retries_and_manifest_bound; fi
}

test_setup_lock_publication_verification() {
  local failed=0 home output before after
  home="$(new_home setup_lock_staging_corrupt)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  printf 'live\n' >"$home/.claude/marker"
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.agents")"
  output="$(run_nexus_overridden "$home" lock_copy_corrupt setup 2>&1)" && failed=1
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.agents")"
  [[ "$output" == *'atomic copy staging verification failed'* && "$before" == "$after" && ! -e "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_lock_post_publish_corrupt)"
  write_lock "$home/.agents/.skill-lock.json"
  mkdir -p "$home/.claude" "$home/.codex"
  output="$(run_nexus_overridden "$home" lock_post_publish_corrupt setup 2>&1)" && failed=1
  [[ -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" && "$output" == *'setup is now initialized/disabled'* && "$output" == *'/nexus-link'* && "$output" == *'$nexus-link'* ]] || failed=1
  assert_no_setup_residue "$home" || failed=1
  if (( failed == 0 )); then pass setup_lock_publication_verification; else fail setup_lock_publication_verification; fi
}

test_setup_rejects_reserved_control_skill_names() {
  local failed=0 home output before after
  local reserved
  for reserved in nexus-setup nexus-help nexus-update nexus-remove nexus; do
    home="$(new_home "setup_reserved_control_$reserved")"
    write_lock "$home/.agents/.skill-lock.json" "$reserved"
    before="$(snapshot_tree "$home")"
    output="$(run_nexus "$home" setup 2>&1)" && failed=1
    after="$(snapshot_tree "$home")"
    [[ "$output" == *'invalid setup lock candidates'* && "$before" == "$after" && ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
    assert_no_setup_residue "$home" || failed=1
  done
  if (( failed == 0 )); then pass setup_rejects_reserved_control_skill_names; else fail setup_rejects_reserved_control_skill_names; fi
}

test_discover_lock_uses_immutable_snapshots() {
  local failed=0 home source output snapshot published
  home="$(new_home discover_snapshot)"
  source="$home/.agents/.skill-lock.json"
  write_lock "$source" alpha
  output="$(HOME="$home" NEXUS_HOME="$home/.nexus" bash -c '
    source "$1"
    source "$2"
    source "$3"
    nexus_init
    discover_lock || exit 1
    snapshot="$DISCOVERED_LOCK_SNAPSHOT"
    cp -- "$snapshot" "$HOME/expected"
    printf "%s\n" "{\"version\":3,\"skills\":{\"beta\":{}}}" >"$DISCOVERED_LOCK"
    atomic_copy "$snapshot" "$LOCK_FILE" false || exit 1
    cmp -s "$HOME/expected" "$LOCK_FILE"
    status=$?
    cleanup_discovered_lock_snapshots
    exit "$status"
  ' bash "$REPO_ROOT/scripts/lib/common.sh" "$REPO_ROOT/scripts/lib/lock.sh" "$REPO_ROOT/scripts/lib/setup.sh" 2>&1)" || { printf '%s\n' "$output" >&2; failed=1; }
  cmp -s "$home/expected" "$home/.nexus/skill-lock.json" || failed=1
  [[ -z "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-lock-candidates.*' -print -quit)" ]] || failed=1
  if (( failed == 0 )); then pass discover_lock_uses_immutable_snapshots; else fail discover_lock_uses_immutable_snapshots; fi
}

test_setup_canonical_failures_retain_publication() {
  local failed=0 home output original retained_temp
  home="$(new_home setup_broken_canonical)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.agents/skills" "$home/.claude/skills/alpha" "$home/.codex/skills/alpha"
  ln -s -- /missing/alpha "$home/.agents/skills/alpha"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  [[ "$output" == *'broken symlink'* && -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" && "$output" == *'setup is now initialized/disabled'* && "$output" == *'/nexus-link'* && "$output" == *'$nexus-link'* ]] || failed=1
  [[ -d "$home/.claude/skills/alpha" && -d "$home/.codex/skills/alpha" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1

  home="$(new_home setup_canonical_restore_failure)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.agents/skills"
  printf 'skill\n' >"$home/.claude/skills/alpha/SKILL.md"
  ln -s -- "../../.claude/skills/alpha" "$home/.agents/skills/alpha"
  output="$(run_nexus_overridden "$home" canonical_restore setup 2>&1)" && failed=1
  original="$(printf '%s\n' "$output" | sed -n 's/.*canonical recovery retained: //p' | tail -n 1)"
  [[ -n "$original" && -L "$original/original" && "$(readlink "$original/original")" == '../../.claude/skills/alpha' && -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1
  [[ -z "$(find "$home/.agents/skills" -maxdepth 1 -name '.nexus-canonical-tmp.*' -print -quit)" ]] || failed=1
  [[ -d "$home/.claude/skills/alpha" ]] || failed=1

  home="$(new_home setup_canonical_cleanup_failure)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.agents/skills"
  printf 'skill\n' >"$home/.claude/skills/alpha/SKILL.md"
  ln -s -- "../../.claude/skills/alpha" "$home/.agents/skills/alpha"
  output="$(run_nexus_overridden "$home" canonical_cleanup setup 2>&1)" && failed=1
  original="$(printf '%s\n' "$output" | sed -n 's/.*canonical recovery retained: //p' | tail -n 1)"
  retained_temp="$(printf '%s\n' "$output" | sed -n 's/.*canonical temp retained: //p' | tail -n 1)"
  [[ -L "$original/original" && -d "$retained_temp" && "$output" == *"$original"* && "$output" == *"$retained_temp"* ]] || failed=1

  home="$(new_home setup_canonical_restore)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.agents/skills"
  printf 'skill\n' >"$home/.claude/skills/alpha/SKILL.md"
  ln -s -- "../../.claude/skills/alpha" "$home/.agents/skills/alpha"
  original="$(readlink "$home/.agents/skills/alpha")"
  output="$(run_nexus_overridden "$home" canonical_promote setup 2>&1)" && failed=1
  [[ -L "$home/.agents/skills/alpha" && "$(readlink "$home/.agents/skills/alpha")" == "$original" ]] || failed=1
  [[ -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1
  if (( failed == 0 )); then pass setup_canonical_failures_retain_publication; else fail setup_canonical_failures_retain_publication; fi
}

test_setup_canonical_safety_preflight() {
  local failed=0 home output before after
  home="$(new_home setup_canonical_root_symlink)"
  mkdir -p "$home/.claude/skills" "$home/.agents"
  mv -- "$home/.agents" "$home/.agents-real"
  ln -s -- .claude "$home/.agents"
  write_lock "$home/.claude/.skill-lock.json" alpha
  before="$(snapshot_tree "$home")"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  after="$(snapshot_tree "$home")"
  [[ "$output" == *'canonical agent root must be a physical directory'* && "$before" == "$after" && ! -e "$home/.claude-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1

  home="$(new_home setup_skill_md_symlink)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.agents/skills/alpha" "$home/.claude/skills/alpha"
  printf 'live\n' >"$home/.claude/skills/alpha/SKILL.md"
  ln -s -- "../../../.claude/skills/alpha/SKILL.md" "$home/.agents/skills/alpha/SKILL.md"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  [[ "$output" == *'physical SKILL.md'* && -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" && -d "$home/.claude/skills/alpha" ]] || failed=1
  if (( failed == 0 )); then pass setup_canonical_safety_preflight; else fail setup_canonical_safety_preflight; fi
}

test_setup_canonical_late_collision_is_preserved() {
  local failed=0 home output status canonical
  home="$(new_home setup_canonical_late_collision)"
  canonical="$home/.agents/skills"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$canonical"
  printf 'skill\n' >"$home/.claude/skills/alpha/SKILL.md"
  ln -s -- ../../.claude/skills/alpha "$canonical/alpha"
  output="$(run_nexus_overridden "$home" canonical_late_collision setup 2>&1)"; status=$?
  [[ "$status" -ne 0 && -f "$canonical/alpha" && "$(<"$canonical/alpha")" == 'late collision' ]] || {
    printf '  late canonical collision was not preserved\n%s\n' "$output" >&2
    failed=1
  }
  if (( failed == 0 )); then pass setup_canonical_late_collision_is_preserved; else fail setup_canonical_late_collision_is_preserved; fi
}

test_setup_canonical_scan_failure_is_propagated() {
  local failed=0 home output status canonical
  home="$(new_home setup_canonical_scan_failure)"
  canonical="$home/.agents/skills"
  write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$canonical/alpha" "$home/.claude/skills/alpha"
  printf 'skill\n' >"$canonical/alpha/SKILL.md"
  printf 'skill\n' >"$home/.claude/skills/alpha/SKILL.md"
  output="$(run_nexus_overridden "$home" canonical_find_fail setup 2>&1)"; status=$?
  [[ "$status" -ne 0 && "$output" == *'cannot scan canonical skill symlinks'* ]] || {
    printf '  canonical symlink scan failure was not propagated\n%s\n' "$output" >&2
    failed=1
  }
  if (( failed == 0 )); then pass setup_canonical_scan_failure_is_propagated; else fail setup_canonical_scan_failure_is_propagated; fi
}

test_metadata() {
  local failed=0
  local ignored
  for ignored in skill-lock.json ui-run.json ui.log; do
    assert_contains .gitignore "$ignored" || failed=1
    if git -C "$REPO_ROOT" check-ignore -q -- "$ignored"; then
      :
    else
      printf '  %s is not actually ignored\n' "$ignored" >&2
      failed=1
    fi
  done

  local name command wrapper
  for name in nexus-setup nexus-link nexus-install nexus-new nexus-help nexus-update nexus-remove nexus; do
    case "$name" in
      nexus-setup) command='/home/luanh/.nexus/scripts/nexus setup' ;;
      nexus-link) command='/home/luanh/.nexus/scripts/nexus link' ;;
      nexus-install) command='/home/luanh/.nexus/scripts/nexus install' ;;
      nexus-new) command='/home/luanh/.nexus/scripts/nexus new' ;;
      nexus-help) command='/home/luanh/.nexus/scripts/nexus' ;;
      nexus-update) command='/home/luanh/.nexus/scripts/nexus update' ;;
      nexus-remove) command='/home/luanh/.nexus/scripts/nexus remove' ;;
      nexus) command='/home/luanh/.nexus/scripts/nexus ui' ;;
    esac
    assert_file "skills/$name/SKILL.md" || failed=1
    [[ ! -e "$REPO_ROOT/skills/$name/claude-command.md" ]] || { printf '  unexpected adapter file: %s\n' "$name" >&2; failed=1; }
    assert_line "skills/$name/SKILL.md" "name: $name" || failed=1
    assert_contains "skills/$name/SKILL.md" "$command" || failed=1
    if [[ "$name" == nexus ]]; then
      # The launcher runs one plain command that ends: no shell wrapper.
      for wrapper in nohup disown mktemp sleep; do
        if grep -Fq -- "$wrapper" "$REPO_ROOT/skills/$name/SKILL.md"; then
          printf '  nexus launcher still wraps the run: %s\n' "$wrapper" >&2
          failed=1
        fi
      done
      assert_contains "skills/$name/SKILL.md" 'nexus ui --stop' || failed=1
      assert_contains "skills/$name/SKILL.md" 'Stop server' || failed=1
    fi
    if [[ "$name" == nexus-install ]]; then
      assert_contains "skills/$name/SKILL.md" '--skill "skill-a" --skill "skill-b"' || failed=1
      if grep -Fq 'install "/path/to/source" "skill-a"' "$REPO_ROOT/skills/$name/SKILL.md"; then
        printf '  nexus-install advertises incompatible positional skills\n' >&2
        failed=1
      fi
    fi
  done

  if (( failed == 0 )); then
    pass metadata
  else
    fail metadata
  fi
}

test_readme_documentation() {
  local failed=0 term
  for term in '~/.agents/skills' 'skill-lock.json' '.claude-backup' '.codex-backup' '/nexus-setup' '$nexus-setup' 'npx skills' 'python3' 'recovery' 'another agent' \
              '~/.custom-skills' '/nexus-new' '$nexus-new' '.workspaces' \
              '/nexus-update' '$nexus-update' '/nexus-remove' '$nexus-remove' '/nexus-help' '$nexus-help' 'nexus list' \
              '`/nexus`' '`$nexus`' 'nexus ui' 'http.server' 'Save changes' \
              '## Global instructions' '~/.custom-skills/GLOBAL.md' '0003-global-instructions-are-a-managed-link-into-the-custom-root.md' \
              '0004-nexus-writes-only-global-md-in-the-custom-root.md' \
              '## Web UI' '0005-nexus-opens-one-loopback-listener-only-in-nexus-ui.md' \
              '0006-a-web-ui-run-is-recorded-in-a-run-file-and-can-be-stopped.md' 'Run File' \
              '#/skills' '#/global' 'POST api/shutdown' \
              'nexus ui --status' 'nexus ui --stop' '~/.nexus/ui-run.json' \
              '--foreground' '~/.nexus/ui.log' 'One run at a time'; do
    assert_contains README.md "$term" || failed=1
  done
  assert_contains README.md 'Setup preflight checks `jq`, `python3`, and the' || failed=1
  assert_contains README.md 'it does not check Git, npm, npx, or NVM' || failed=1
  assert_contains README.md 'directly available `npx`; if it is unavailable, NVM is the fallback' || failed=1
  assert_contains README.md 'retries once and then removes the temporary transaction, leaves' || failed=1
  if (( failed == 0 )); then pass readme_documentation; else fail readme_documentation; fi
}

test_metadata
test_readme_documentation
test_source_hygiene
test_shell_syntax
test_bootstrap
test_bootstrap_collision
test_bootstrap_staging_failure
test_bootstrap_lexical_managed_link
test_bootstrap_symlinked_managed_root
test_force_replacement
test_force_recovery
test_install_cli_and_nvm_fallback
test_dispatcher
test_force_env_does_not_bypass_bootstrap
test_link_invalid_locks_do_not_mutate
test_link_reconciliation
test_link_stale_ownership_and_empty_lock
test_link_desired_collisions_are_preserved
test_link_snapshot_safety
test_custom_link_reconciliation
test_custom_root_validation
test_custom_collision_and_canonical_forbidden
test_new_cli
test_install_rejects_custom_collision
test_setup_happy_and_idempotent
test_setup_preflight_and_lock_discovery
test_setup_backup_transaction_and_absent_roots
test_setup_backup_retries_and_manifest_bound
test_setup_lock_publication_verification
test_setup_rejects_reserved_control_skill_names
test_setup_canonical_failures_retain_publication
test_setup_canonical_safety_preflight
test_setup_canonical_late_collision_is_preserved
test_setup_canonical_scan_failure_is_propagated
test_discover_lock_uses_immutable_snapshots

# Per-subcommand test cases live in tests/cases/<name>.sh. Each file defines
# functions and appends their names to CASE_TESTS; they run here in file order.
CASE_TESTS=()
for case_file in "$REPO_ROOT"/tests/cases/*.sh; do
  [[ -f "$case_file" ]] || continue
  source "$case_file"
done
for case_test in "${CASE_TESTS[@]}"; do
  "$case_test"
done

test_term_recovery() {
  local failed=0 home pid output status
  home="$(new_home term_pre)"; write_lock "$home/.agents/.skill-lock.json"; mkdir -p "$home/.claude" "$home/.codex"
  printf live >"$home/.claude/marker"; printf live >"$home/.codex/marker"
  start_nexus_overridden "$home" term_pre "$home/pre-output" setup || failed=1
  pid="$NEXUS_TEST_PID"
  wait_handshake "$home/pre-handshake" "$pid" || { failed=1; cat "$home/pre-output" >&2; }
  stop_and_reap "$pid"; status="$NEXUS_WAIT_STATUS"
  (( status != 0 && status != 127 )) || { cat "$home/pre-output" >&2; failed=1; }
  [[ ! -e "$home/.claude-backup" && ! -e "$home/.codex-backup" && ! -e "$home/.nexus/skill-lock.json" ]] || failed=1
  [[ -f "$home/.claude/marker" && -f "$home/.codex/marker" ]] || failed=1
  grep -Eq 'interrupted|rerun|retained' "$home/pre-output" || failed=1
  assert_no_setup_residue "$home" || failed=1
  [[ ! -e "$home/.nexus/.nexus-setup.lock" ]] || failed=1

  home="$(new_home term_post)"; write_lock "$home/.agents/.skill-lock.json"; mkdir -p "$home/.claude" "$home/.codex"
  start_nexus_overridden "$home" term_post "$home/post-output" setup || failed=1
  pid="$NEXUS_TEST_PID"
  wait_handshake "$home/post-handshake" "$pid" || { failed=1; cat "$home/post-output" >&2; }
  [[ -d "$home/.claude-backup" && -d "$home/.codex-backup" && -f "$home/.nexus/skill-lock.json" ]] || failed=1
  stop_and_reap "$pid"; status="$NEXUS_WAIT_STATUS"
  (( status != 0 && status != 127 )) || { cat "$home/post-output" >&2; failed=1; }
  grep -Fq "$home/.nexus/skill-lock.json" "$home/post-output" || failed=1
  grep -Fq '/nexus-link' "$home/post-output" || failed=1
  grep -Fq '$nexus-link' "$home/post-output" || failed=1
  [[ ! -e "$home/.nexus/.nexus-setup.lock" ]] || failed=1
  assert_no_setup_residue "$home" || failed=1
  [[ "$(<"$home/post-output")" != *'.nexus-lock.'* && "$(<"$home/post-output")" != *'.nexus-lock-candidates.'* && "$(<"$home/post-output")" != *'.nexus-setup-source.'* && "$(<"$home/post-output")" != *'.nexus-setup-copy.'* ]] || failed=1

  home="$(new_home term_pre_cleanup_fail)"; write_lock "$home/.agents/.skill-lock.json"; mkdir -p "$home/.claude" "$home/.codex"
  start_nexus_overridden "$home" term_pre_cleanup_fail "$home/fail-pre-output" setup || failed=1
  pid="$NEXUS_TEST_PID"
  wait_handshake "$home/pre-handshake" "$pid" || { failed=1; cat "$home/fail-pre-output" >&2; }
  stop_and_reap "$pid"; status="$NEXUS_WAIT_STATUS"
  retained="$(sed -n 's/.*retained setup temp paths: //p' "$home/fail-pre-output" | tail -n 1)"
  [[ "$status" -eq 143 && -n "$retained" && -e "$retained" && "$(<"$home/fail-pre-output")" == *"retained setup temp paths: $retained"* && "$(<"$home/fail-pre-output")" == *'rerun setup'* ]] || failed=1
  [[ "$retained" == "$home/.nexus/.nexus-lock."* ]] || failed=1

  home="$(new_home term_post_cleanup_fail)"; write_lock "$home/.agents/.skill-lock.json"; mkdir -p "$home/.claude" "$home/.codex"
  start_nexus_overridden "$home" term_post_cleanup_fail "$home/fail-post-output" setup || failed=1
  pid="$NEXUS_TEST_PID"
  wait_handshake "$home/post-handshake" "$pid" || { failed=1; cat "$home/fail-post-output" >&2; }
  stop_and_reap "$pid"; status="$NEXUS_WAIT_STATUS"
  retained="$(sed -n 's/.*retained setup temp paths: //p' "$home/fail-post-output" | tail -n 1)"
  [[ "$status" -eq 143 && -n "$retained" && -e "$retained" && "$(<"$home/fail-post-output")" == *"retained setup temp paths: $retained"* && "$(<"$home/fail-post-output")" == *"$home/.nexus/skill-lock.json"* && "$(<"$home/fail-post-output")" == *'/nexus-link'* && "$(<"$home/fail-post-output")" == *'retained final/recovery paths'* ]] || failed=1
  [[ "$retained" == "$home/.nexus/.nexus-lock."* && "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-setup-*' -print -quit)" == '' ]] || failed=1
  if (( failed == 0 )); then pass term_recovery; else fail term_recovery; fi
}

test_nested_source_symlink_safety() {
  local failed=0 home output canonical outside

  home="$(new_home nested_escape)"; write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.agents/skills" "$home/.codex/skills"
  printf 'alpha\n' >"$home/.claude/skills/alpha/SKILL.md"
  outside="$TEST_ROOT/nested-secret"; printf 'secret\n' >"$outside"
  ln -s -- "$outside" "$home/.claude/skills/alpha/secret"
  canonical="$home/.agents/skills/alpha"; ln -s -- ../../.claude/skills/alpha "$canonical"
  ln -s -- /external/agent-alpha "$home/.codex/skills/alpha"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  [[ "$output" == *'nested source symlink'* && -f "$outside" && "$(readlink "$canonical")" == '../../.claude/skills/alpha' ]] || failed=1
  [[ -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1
  [[ "$(readlink "$home/.codex/skills/alpha")" == /external/agent-alpha ]] || failed=1
  [[ "$output" == *'/nexus-link'* && "$output" == *'$nexus-link'* ]] || failed=1

  home="$(new_home nested_broken)"; write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.agents/skills"
  printf 'alpha\n' >"$home/.claude/skills/alpha/SKILL.md"
  ln -s -- missing "$home/.claude/skills/alpha/broken"
  canonical="$home/.agents/skills/alpha"; ln -s -- ../../.claude/skills/alpha "$canonical"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  [[ "$output" == *'nested source symlink'* && "$(readlink "$canonical")" == '../../.claude/skills/alpha' ]] || failed=1
  [[ -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1

  home="$(new_home nested_cyclic)"; write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.agents/skills"
  printf 'alpha\n' >"$home/.claude/skills/alpha/SKILL.md"
  ln -s -- cycle-b "$home/.claude/skills/alpha/cycle-a"
  ln -s -- cycle-a "$home/.claude/skills/alpha/cycle-b"
  canonical="$home/.agents/skills/alpha"; ln -s -- ../../.claude/skills/alpha "$canonical"
  output="$(run_nexus "$home" setup 2>&1)" && failed=1
  [[ "$output" == *'nested source symlink'* && "$(readlink "$canonical")" == '../../.claude/skills/alpha' ]] || failed=1
  [[ -f "$home/.nexus/skill-lock.json" && -d "$home/.claude-backup" && -d "$home/.codex-backup" ]] || failed=1

  home="$(new_home nested_internal)"; write_lock "$home/.agents/.skill-lock.json" alpha
  mkdir -p "$home/.claude/skills/alpha" "$home/.agents/skills"
  printf 'alpha\n' >"$home/.claude/skills/alpha/SKILL.md"
  printf 'nested\n' >"$home/.claude/skills/alpha/target"
  ln -s -- target "$home/.claude/skills/alpha/nested"
  canonical="$home/.agents/skills/alpha"; ln -s -- ../../.claude/skills/alpha "$canonical"
  output="$(run_nexus "$home" setup 2>&1)" || failed=1
  [[ -d "$canonical" && ! -L "$canonical" && -f "$canonical/nested" && ! -L "$canonical/nested" ]] || failed=1
  if (( failed == 0 )); then pass nested_source_symlink_safety; else fail nested_source_symlink_safety; fi
}

test_setup_traps_restore() {
  local failed=0 home output
  home="$(new_home trap_restore)"; write_lock "$home/.agents/.skill-lock.json"
  output="$(HOME="$home" NEXUS_HOME="$home/.nexus" bash -c '
    source "$1"; nexus_init
    trap "printf EXIT-MARKER >&2" EXIT; trap "printf INT-MARKER >&2" INT; trap "printf TERM-MARKER >&2" TERM
    before_exit="$(trap -p EXIT)"; before_int="$(trap -p INT)"; before_term="$(trap -p TERM)"
    setup; a=$?; [[ "$before_exit" == "$(trap -p EXIT)" && "$before_int" == "$(trap -p INT)" && "$before_term" == "$(trap -p TERM)" ]] || exit 1
    rm -f "$NEXUS_HOME/skill-lock.json"; setup >/dev/null 2>&1; b=$?
    ok=$([[ "$before_exit" == "$(trap -p EXIT)" && "$before_int" == "$(trap -p INT)" && "$before_term" == "$(trap -p TERM)" && "$a" -eq 0 && "$b" -ne 0 ]] && echo yes || echo no)
    trap - EXIT INT TERM
    [[ "$ok" == yes ]]
  ' bash "$REPO_ROOT/scripts/nexus" 2>&1)" || failed=1
  [[ "$output" != *EXIT-MARKER* ]] || failed=1
  if (( failed == 0 )); then pass setup_traps_restore; else fail setup_traps_restore; fi
}

test_setup_finalization_signal_window() {
  local failed=0 home output pid status
  home="$(new_home finalization_signal_window)"
  write_lock "$home/.agents/.skill-lock.json" alpha
  start_nexus_overridden "$home" final_cleanup "$home/output" setup || failed=1
  pid="$NEXUS_TEST_PID"
  wait_handshake "$home/finalization-handshake" "$pid" || {
    failed=1
    cat "$home/output" >&2
  }
  kill -TERM "$pid" 2>/dev/null || failed=1
  : >"$home/finalization-release"
  wait "$pid" 2>/dev/null
  status=$?
  output="$(<"$home/output")"
  [[ "$status" -eq 143 && -d "$home/.claude-backup" && -d "$home/.codex-backup" &&
     -f "$home/.nexus/skill-lock.json" && ! -e "$home/.nexus/.nexus-setup.lock" &&
     -z "$(find "$home/.nexus" -maxdepth 1 \( -name '.nexus-lock-candidates.*' -o -name '.nexus-setup-*' \) -print -quit)" &&
     "$output" == *'setup interrupted'* && "$output" == *'/nexus-link'* &&
     "$output" == *'$nexus-link'* ]] || failed=1
  if (( failed == 0 )); then pass setup_finalization_signal_window; else fail setup_finalization_signal_window; fi
}

test_setup_canonical_scan_signal_cleanup() {
  local failed=0 home output pid status canonical
  home="$(new_home canonical_scan_signal_cleanup)"
  canonical="$home/.agents/skills"
  mkdir -p "$home/tmp" "$canonical/alpha"
  write_lock "$home/.agents/.skill-lock.json" alpha
  printf 'skill\n' >"$canonical/alpha/SKILL.md"
  output="$home/output"
  TMPDIR="$home/tmp/" HOME="$home" NEXUS_HOME="$home/.nexus" NEXUS_FAULT=canonical_scan_window \
    bash -c 'export NEXUS_FAULT="$3"; source "$1"; nexus_init; source "$2"; fault_setup; main setup' \
      bash "$REPO_ROOT/scripts/nexus" "$REPO_ROOT/tests/faults.sh" canonical_scan_window setup >"$output" 2>&1 &
  pid=$!
  wait_handshake "$home/scan-handshake" "$pid" || { failed=1; cat "$output" >&2; }
  kill -TERM "$pid" 2>/dev/null || failed=1
  : >"$home/scan-release"
  wait "$pid" 2>/dev/null; status=$?
  [[ "$status" -eq 143 && -z "$(find "$home/tmp" -name '.nexus-canonical-scan.*' -print -quit)" ]] || failed=1
  if (( failed == 0 )); then pass setup_canonical_scan_signal_cleanup; else fail setup_canonical_scan_signal_cleanup; fi
}

test_setup_canonical_scan_trailing_tmpdir() {
  local failed=0 home canonical output
  home="$(new_home canonical_scan_trailing_tmpdir)"
  canonical="$home/.agents/skills"
  mkdir -p "$home/tmp" "$canonical/alpha" "$home/.claude" "$home/.codex"
  write_lock "$home/.agents/.skill-lock.json" alpha
  printf 'skill\n' >"$canonical/alpha/SKILL.md"
  output="$(TMPDIR="$home/tmp/" HOME="$home" NEXUS_HOME="$home/.nexus" "$REPO_ROOT/scripts/nexus" setup 2>&1)" || {
    printf '%s\n' "$output" >&2
    failed=1
  }
  [[ -z "$(find "$home/tmp" -name '.nexus-canonical-scan.*' -print -quit)" ]] || failed=1
  if (( failed == 0 )); then pass setup_canonical_scan_trailing_tmpdir; else fail setup_canonical_scan_trailing_tmpdir; fi
}

test_term_recovery
test_setup_traps_restore
test_setup_finalization_signal_window
test_setup_canonical_scan_signal_cleanup
test_setup_canonical_scan_trailing_tmpdir
test_nested_source_symlink_safety

if python3 "$REPO_ROOT/tests/backup_manifest_test.py" >/dev/null; then
  pass backup_manifest_fixtures
else
  fail backup_manifest_fixtures
fi
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
