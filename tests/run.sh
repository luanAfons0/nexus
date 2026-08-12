#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() {
  rm -rf -- "$TEST_ROOT"
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

test_metadata() {
  local failed=0
  assert_contains .gitignore 'skill-lock.json' || failed=1

  local name
  for name in nexus-setup nexus-link nexus-install; do
    assert_file "skills/$name/SKILL.md" || failed=1
    assert_file "skills/$name/claude-command.md" || failed=1
    assert_contains "skills/$name/SKILL.md" "name: $name" || failed=1
    assert_contains "skills/$name/SKILL.md" '/home/luanh/.nexus/scripts/nexus' || failed=1
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
