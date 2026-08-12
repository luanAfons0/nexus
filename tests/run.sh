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
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
