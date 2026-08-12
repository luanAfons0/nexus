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
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
