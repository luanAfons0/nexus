# nexus check. Every case drives the CLI as a subprocess against an isolated
# fake HOME, with a fake `gh` on PATH as the GitHub seam. No case reaches the
# network: the fake answers every call, and the one case that proves the
# refusal without `gh` runs on a PATH that holds nothing else.

check_fake_gh() {
  local dir="$1"
  mkdir -p -- "$dir"
  cat >"$dir/gh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$HOME/gh-args"
if [[ "$1" == auth ]]; then
  if [[ "${NEXUS_FAKE_GH_MODE:-ok}" == logged_out ]]; then
    printf 'You are not logged into any GitHub hosts.\n' >&2
    exit 1
  fi
  exit 0
fi
for arg in "$@"; do
  case "$arg" in
    repos/owner/moved/commits) printf '2026-06-01T10:00:00Z\n'; exit 0 ;;
    repos/owner/quiet/commits) printf '2025-06-01T10:00:00Z\n'; exit 0 ;;
    repos/owner/gone/commits) printf 'gh: Not Found (HTTP 404)\n' >&2; exit 1 ;;
  esac
done
printf 'gh: the fake was asked for something no case set up\n' >&2
exit 1
FAKE
  chmod 755 "$dir/gh"
}

# A lock of four Installed Skills: two in one repository, one in a repository
# the fake cannot reach, and one whose SKILL.md is the root of its own.
check_write_lock() {
  local path="$1"
  mkdir -p -- "$(dirname -- "$path")"
  jq -n '
    {
      version: 3,
      skills: {
        "behind-skill": { source: "owner/moved", sourceType: "github",
          skillPath: "skills/behind-skill/SKILL.md", skillFolderHash: "aaaa",
          installedAt: "2026-01-01T00:00:00.500Z", updatedAt: "2026-01-01T00:00:00.500Z" },
        "current-skill": { source: "owner/quiet", sourceType: "github",
          skillPath: "skills/current-skill/SKILL.md", skillFolderHash: "bbbb",
          installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        "unreachable-skill": { source: "owner/gone", sourceType: "github",
          skillPath: "skills/unreachable-skill/SKILL.md", skillFolderHash: "cccc",
          installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        "whole-repository-skill": { source: "owner/moved", sourceType: "github",
          skillPath: "SKILL.md", skillFolderHash: "dddd",
          installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
      }
    }' >"$path"
}

# A PATH that holds what the CLI needs to run and no `gh`, so the refusal it
# prints is the one about `gh`, and so a road that asks GitHub nothing can be
# proved to ask nothing: it works where `gh` does not exist.
check_bin_without_gh() {
  local dir="$1" name source
  mkdir -p -- "$dir"
  for name in bash dirname python3 jq date mktemp; do
    source="$(command -v "$name")" || return 1
    ln -sf -- "$source" "$dir/$name"
  done
}

# The CLI on a PATH of its own, which `run_nexus` cannot give.
run_nexus_on_path() {
  local home="$1" path="$2"
  shift 2
  HOME="$home" NEXUS_HOME="$home/.nexus" PATH="$path" bash "$REPO_ROOT/scripts/nexus" "$@"
}

# One request to the Plugin Server, answered and gone. Every call is its own
# server, as a caller on the Tool Bus is.
check_ask_server() {
  local home="$1" path="$2" request="$3"
  printf '%s\n' "$request" | HOME="$home" NEXUS_HOME="$home/.nexus" PATH="$path" \
    python3 "$REPO_ROOT/mcp" 2>/dev/null
}

test_check_reports_current_behind_and_unknown() {
  local failed=0 home fake result output status before after lock_before lock_after
  home="$(custom_home check_states)"
  fake="$home/fakebin"
  result="$home/.nexus/skill-check.json"
  check_fake_gh "$fake"
  check_write_lock "$home/.nexus/skill-lock.json"
  lock_before="$(sha256sum "$home/.nexus/skill-lock.json")"
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.agents")"

  output="$(PATH="$fake:$PATH" run_nexus "$home" check 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *$'behind-skill\tbehind\towner/moved\t2026-01-01T00:00:00.500Z\t2026-06-01T10:00:00Z'* ]] ||
    { printf '  no behind row\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *$'current-skill\tcurrent\towner/quiet'* ]] ||
    { printf '  no current row\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *$'unreachable-skill\tunknown\towner/gone\t2026-01-01T00:00:00Z\t-'* ]] ||
    { printf '  no unknown row\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *'unknown unreachable-skill: could not reach owner/gone'* ]] ||
    { printf '  the unknown row carries no reason\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *'1 current, 2 behind, 1 unknown'* ]] ||
    { printf '  wrong counts\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *"$result"* ]] || { printf '  the summary does not name the result file\n' >&2; failed=1; }

  # GitHub is asked about the Skill's folder, and about the whole repository
  # when the Skill is the whole repository.
  grep -Fxq -- 'path=skills/behind-skill' "$home/gh-args" || { printf '  no folder in the gh call\n' >&2; failed=1; }
  grep -Fxq -- 'path=SKILL.md' "$home/gh-args" && { printf '  gh was asked about SKILL.md itself\n' >&2; failed=1; }
  grep -Fxq -- 'auth' "$home/gh-args" || { printf '  gh auth was never asked\n' >&2; failed=1; }

  # The check applies nothing.
  lock_after="$(sha256sum "$home/.nexus/skill-lock.json")"
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.agents")"
  [[ "$lock_before" == "$lock_after" ]] || { printf '  the check changed the Nexus lock\n' >&2; failed=1; }
  [[ "$before" == "$after" ]] || { printf '  the check changed a skill or a link\n' >&2; failed=1; }
  [[ -z "$(find "$home/.nexus" -maxdepth 1 -name '.nexus-tmp.*' -print -quit)" ]] ||
    { printf '  check scratch retained\n' >&2; failed=1; }

  # The result is Nexus's own file, beside the lock and never inside it.
  [[ -f "$result" ]] || { printf '  no check result file\n' >&2; failed=1; }
  jq -e '.skills | length == 4' "$result" >/dev/null || failed=1
  [[ "$(jq -r '.skills[] | select(.name == "behind-skill") | .state' "$result")" == behind ]] || failed=1
  [[ "$(jq -r '.skills[] | select(.name == "current-skill") | .state' "$result")" == current ]] || failed=1
  [[ "$(jq -r '.skills[] | select(.name == "unreachable-skill") | .state' "$result")" == unknown ]] || failed=1
  [[ "$(jq -r '.skills[] | select(.name == "unreachable-skill") | .committedAt' "$result")" == null ]] || failed=1
  [[ "$(jq -r '.skills[] | select(.name == "whole-repository-skill") | .folder' "$result")" == '' ]] || failed=1
  jq -e '.counts == { current: 1, behind: 2, unknown: 1 }' "$result" >/dev/null ||
    { printf '  wrong counts in the result file\n' >&2; failed=1; }
  jq -e '.checkedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")' "$result" >/dev/null ||
    { printf '  the result carries no moment\n' >&2; failed=1; }
  jq -e 'any(.skills[]; .state == "unknown" and .reason == null) | not' "$result" >/dev/null ||
    { printf '  an unknown skill carries no reason\n' >&2; failed=1; }
  jq -e '.skills[] | select(.state != "current" and .state != "behind" and .state != "unknown")' "$result" >/dev/null &&
    { printf '  a skill carries a state that is not one of the three\n' >&2; failed=1; }

  # --json prints the same document the file holds.
  output="$(PATH="$fake:$PATH" run_nexus "$home" check --json 2>/dev/null)"; status=$?
  [[ "$status" -eq 0 ]] || failed=1
  [[ "$(printf '%s\n' "$output" | jq -S .)" == "$(jq -S . "$result")" ]] ||
    { printf '  --json and the result file disagree\n' >&2; failed=1; }

  if (( failed == 0 )); then pass check_reports_current_behind_and_unknown; else fail check_reports_current_behind_and_unknown; fi
}

test_check_refuses_without_gh() {
  local failed=0 home bin output status
  home="$(custom_home check_no_gh)"
  bin="$home/nogh"
  check_bin_without_gh "$bin" || { fail check_refuses_without_gh; return; }
  check_write_lock "$home/.nexus/skill-lock.json"

  output="$(run_nexus_on_path "$home" "$bin" check 2>&1)"; status=$?
  [[ "$status" -eq 1 ]] || { printf '  unexpected status: %s\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *'the GitHub CLI is not available: install gh, then run gh auth login'* ]] ||
    { printf '%s\n' "$output" >&2; failed=1; }
  [[ ! -e "$home/.nexus/skill-check.json" ]] || { printf '  a refusal wrote a check result\n' >&2; failed=1; }

  if (( failed == 0 )); then pass check_refuses_without_gh; else fail check_refuses_without_gh; fi
}

test_check_refuses_when_gh_is_not_logged_in() {
  local failed=0 home fake output status
  home="$(custom_home check_logged_out)"
  fake="$home/fakebin"
  check_fake_gh "$fake"
  check_write_lock "$home/.nexus/skill-lock.json"

  output="$(NEXUS_FAKE_GH_MODE=logged_out PATH="$fake:$PATH" run_nexus "$home" check 2>&1)"; status=$?
  [[ "$status" -eq 1 ]] || { printf '  unexpected status: %s\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *'the GitHub CLI is not logged in: run gh auth login'* ]] ||
    { printf '%s\n' "$output" >&2; failed=1; }
  grep -Fxq -- 'api' "$home/gh-args" && { printf '  a logged-out check still asked GitHub\n' >&2; failed=1; }
  [[ ! -e "$home/.nexus/skill-check.json" ]] || { printf '  a refusal wrote a check result\n' >&2; failed=1; }

  if (( failed == 0 )); then pass check_refuses_when_gh_is_not_logged_in; else fail check_refuses_when_gh_is_not_logged_in; fi
}

test_check_refuses_without_a_lock() {
  local failed=0 home fake output status
  home="$(custom_home check_no_lock)"
  fake="$home/fakebin"
  check_fake_gh "$fake"

  output="$(PATH="$fake:$PATH" run_nexus "$home" check 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *"lock is absent: $home/.nexus/skill-lock.json"* ]] ||
    { printf '  unexpected status %s\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ ! -e "$home/.nexus/skill-check.json" ]] || { printf '  a refusal wrote a check result\n' >&2; failed=1; }

  output="$(PATH="$fake:$PATH" run_nexus "$home" check --all 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage:'* ]] || { printf '%s\n' "$output" >&2; failed=1; }

  if (( failed == 0 )); then pass check_refuses_without_a_lock; else fail check_refuses_without_a_lock; fi
}

# The Plugin Server offers the check to the Tool Bus, and a failed check is a
# JSON-RPC error there rather than a result carrying a non-zero exit, because
# a caller has to be able to decide an Outcome from it.
test_check_tool_reports_a_failure_as_a_tool_error() {
  local failed=0 home fake bin request response
  home="$(custom_home check_tool)"
  fake="$home/fakebin"
  bin="$home/nogh"
  check_fake_gh "$fake"
  check_bin_without_gh "$bin" || { fail check_tool_reports_a_failure_as_a_tool_error; return; }
  check_write_lock "$home/.nexus/skill-lock.json"

  request='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
  response="$(check_ask_server "$home" "$fake:$PATH" "$request")"
  printf '%s\n' "$response" | jq -e '.result.tools | any(.name == "check_skills")' >/dev/null ||
    { printf '  the plugin server does not offer check_skills\n%s\n' "$response" >&2; failed=1; }

  request='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_skills","arguments":{}}}'
  response="$(check_ask_server "$home" "$fake:$PATH" "$request")"
  [[ "$(printf '%s\n' "$response" | jq -r '.result.structuredContent.exit')" == 0 ]] ||
    { printf '  a check that worked is not a result\n%s\n' "$response" >&2; failed=1; }
  printf '%s\n' "$response" | jq -e '.result.structuredContent.json.counts.behind == 2' >/dev/null ||
    { printf '  the result carries no counts\n%s\n' "$response" >&2; failed=1; }

  response="$(check_ask_server "$home" "$bin" "$request")"
  printf '%s\n' "$response" | jq -e 'has("result") | not' >/dev/null ||
    { printf '  a failed check came back as a result\n%s\n' "$response" >&2; failed=1; }
  [[ "$(printf '%s\n' "$response" | jq -r '.error.message')" == *'gh auth login'* ]] ||
    { printf '  the tool error is not a sentence about gh\n%s\n' "$response" >&2; failed=1; }

  if (( failed == 0 )); then pass check_tool_reports_a_failure_as_a_tool_error; else fail check_tool_reports_a_failure_as_a_tool_error; fi
}

# The Plugin Page marks its rows from the Check Result every time somebody
# opens it, so reading the last result has to cost nothing: no `gh`, no
# network and no lock. The proof is that it works on a PATH with no `gh` on
# it, and that the fake `gh` is not asked one more question.
test_check_last_prints_the_result_without_asking_github() {
  local failed=0 home fake bin result output status asked_before asked_after
  home="$(custom_home check_last)"
  fake="$home/fakebin"
  bin="$home/nogh"
  result="$home/.nexus/skill-check.json"
  check_fake_gh "$fake"
  check_bin_without_gh "$bin" || { fail check_last_prints_the_result_without_asking_github; return; }
  check_write_lock "$home/.nexus/skill-lock.json"

  output="$(PATH="$fake:$PATH" run_nexus "$home" check 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  asked_before="$(wc -l <"$home/gh-args")"

  output="$(run_nexus_on_path "$home" "$bin" check --last 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  unexpected status %s\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *$'behind-skill\tbehind\towner/moved\t2026-01-01T00:00:00.500Z\t2026-06-01T10:00:00Z'* ]] ||
    { printf '  no behind row\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *$'current-skill\tcurrent\towner/quiet'* ]] ||
    { printf '  no current row\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *'unknown unreachable-skill: could not reach owner/gone'* ]] ||
    { printf '  the unknown row carries no reason\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *'1 current, 2 behind, 1 unknown'* ]] ||
    { printf '  wrong counts\n%s\n' "$output" >&2; failed=1; }
  asked_after="$(wc -l <"$home/gh-args")"
  [[ "$asked_before" == "$asked_after" ]] || { printf '  --last asked GitHub\n' >&2; failed=1; }

  output="$(run_nexus_on_path "$home" "$bin" check --last --json 2>/dev/null)"; status=$?
  [[ "$status" -eq 0 ]] || failed=1
  [[ "$(printf '%s\n' "$output" | jq -S .)" == "$(jq -S . "$result")" ]] ||
    { printf '  --last --json and the result file disagree\n' >&2; failed=1; }

  # The answer is about the moment the check ran, so a lock that has moved
  # since, or gone, does not stop it from being read.
  rm -f -- "$home/.nexus/skill-lock.json"
  output="$(run_nexus_on_path "$home" "$bin" check --last --json 2>/dev/null)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '  a missing lock stopped a read\n' >&2; failed=1; }
  [[ "$(printf '%s\n' "$output" | jq -r '.counts.behind')" == 2 ]] || failed=1

  if (( failed == 0 )); then pass check_last_prints_the_result_without_asking_github
  else fail check_last_prints_the_result_without_asking_github; fi
}

# A result that is not there and a result that is not a result are each one
# sentence and exit 1. Neither may read as good news: a caller that shows
# marks has to show none rather than imply that every Skill is current.
test_check_last_refuses_what_it_cannot_read() {
  local failed=0 home bin result output status before
  home="$(custom_home check_last_refusals)"
  bin="$home/nogh"
  result="$home/.nexus/skill-check.json"
  check_bin_without_gh "$bin" || { fail check_last_refuses_what_it_cannot_read; return; }
  check_write_lock "$home/.nexus/skill-lock.json"

  output="$(run_nexus_on_path "$home" "$bin" check --last 2>&1)"; status=$?
  [[ "$status" -eq 1 ]] || { printf '  unexpected status %s\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *"no check has run yet: run nexus check to write $result"* ]] ||
    { printf '%s\n' "$output" >&2; failed=1; }
  [[ ! -e "$result" ]] || { printf '  a refusal wrote a check result\n' >&2; failed=1; }

  # Half a file, and a whole JSON document that is not a Check Result, are
  # both unreadable, and neither is corrected in place.
  printf 'half a result\n' >"$result"
  before="$(sha256sum "$result")"
  output="$(run_nexus_on_path "$home" "$bin" check --last 2>&1)"; status=$?
  [[ "$status" -eq 1 ]] || { printf '  unexpected status %s\n%s\n' "$status" "$output" >&2; failed=1; }
  [[ "$output" == *"the check result is unreadable: run nexus check to write $result again"* ]] ||
    { printf '%s\n' "$output" >&2; failed=1; }
  [[ "$before" == "$(sha256sum "$result")" ]] || { printf '  a read rewrote the result\n' >&2; failed=1; }

  jq -n '{ checkedAt: "2026-01-01T00:00:00Z" }' >"$result"
  output="$(run_nexus_on_path "$home" "$bin" check --last --json 2>&1)"; status=$?
  [[ "$status" -eq 1 ]] || { printf '  a document without skills was read as one\n%s\n' "$output" >&2; failed=1; }
  [[ "$output" == *'the check result is unreadable'* && "$output" != *current* ]] ||
    { printf '  the refusal says the wrong thing\n%s\n' "$output" >&2; failed=1; }

  if (( failed == 0 )); then pass check_last_refuses_what_it_cannot_read
  else fail check_last_refuses_what_it_cannot_read; fi
}

# The page reads the Check Result and never asks for a Check, so the Plugin
# Server offers the reading road too. Its refusals stay envelopes: nobody has
# to decide an Outcome from them, and the page shows what the command line
# shows (ADR 0008).
test_check_result_tool_reads_the_last_check() {
  local failed=0 home fake bin request response output status
  home="$(custom_home check_result_tool)"
  fake="$home/fakebin"
  bin="$home/nogh"
  check_fake_gh "$fake"
  check_bin_without_gh "$bin" || { fail check_result_tool_reads_the_last_check; return; }
  check_write_lock "$home/.nexus/skill-lock.json"

  request='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
  response="$(check_ask_server "$home" "$bin" "$request")"
  printf '%s\n' "$response" | jq -e '.result.tools | any(.name == "show_check_result")' >/dev/null ||
    { printf '  the plugin server does not offer show_check_result\n%s\n' "$response" >&2; failed=1; }

  request='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"show_check_result","arguments":{}}}'
  response="$(check_ask_server "$home" "$bin" "$request")"
  printf '%s\n' "$response" | jq -e 'has("result")' >/dev/null ||
    { printf '  a check nobody has run came back as a tool error\n%s\n' "$response" >&2; failed=1; }
  [[ "$(printf '%s\n' "$response" | jq -r '.result.structuredContent.exit')" == 1 ]] ||
    { printf '  the refusal is not an exit code\n%s\n' "$response" >&2; failed=1; }
  [[ "$(printf '%s\n' "$response" | jq -r '.result.structuredContent.stderr')" == *'no check has run yet'* ]] ||
    { printf '  the refusal is not a sentence a person can act on\n%s\n' "$response" >&2; failed=1; }
  printf '%s\n' "$response" | jq -e '.result.content[0].text | fromjson | .exit == 1' >/dev/null ||
    { printf '  this tool stopped answering with its envelope\n%s\n' "$response" >&2; failed=1; }

  output="$(PATH="$fake:$PATH" run_nexus "$home" check 2>&1)"; status=$?
  [[ "$status" -eq 0 ]] || { printf '%s\n' "$output" >&2; failed=1; }
  response="$(check_ask_server "$home" "$bin" "$request")"
  printf '%s\n' "$response" | jq -e '.result.structuredContent
    | .exit == 0 and .json.counts == { current: 1, behind: 2, unknown: 1 }
      and (.json.checkedAt | type) == "string"' >/dev/null ||
    { printf '  the last check did not come back whole\n%s\n' "$response" >&2; failed=1; }

  if (( failed == 0 )); then pass check_result_tool_reads_the_last_check
  else fail check_result_tool_reads_the_last_check; fi
}

# A caller on the Tool Bus shows one sentence of what a tool answered, and how
# many Installed Skills are Behind is the whole question the check exists to
# answer. So the check's text half is that sentence; every other tool's text
# half is still the envelope, and so is the check's structured half.
test_check_tool_answers_with_one_sentence() {
  local failed=0 home fake request response text moment
  home="$(custom_home check_sentence)"
  fake="$home/fakebin"
  check_fake_gh "$fake"
  check_write_lock "$home/.nexus/skill-lock.json"

  request='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_skills","arguments":{}}}'
  response="$(check_ask_server "$home" "$fake:$PATH" "$request")"
  text="$(printf '%s\n' "$response" | jq -r '.result.content[0].text')"
  moment="$(printf '%s\n' "$response" | jq -r '.result.structuredContent.json.checkedAt')"
  [[ "$text" == "4 Installed Skills: 1 current, 2 Behind, 1 unknown. Checked $moment." ]] ||
    { printf '  the check does not answer with a sentence: %s\n' "$text" >&2; failed=1; }

  printf '%s\n' "$response" | jq -e '.result.structuredContent
    | has("command") and has("exit") and has("stdout") and has("stderr")
      and (.json.skills | length == 4)' >/dev/null ||
    { printf '  the structured half is no longer the whole envelope\n%s\n' "$response" >&2; failed=1; }

  request='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_skills","arguments":{}}}'
  response="$(check_ask_server "$home" "$fake:$PATH" "$request")"
  printf '%s\n' "$response" | jq -e '.result.content[0].text | fromjson
    | has("command") and has("exit") and has("stdout") and has("stderr")' >/dev/null ||
    { printf '  another tool stopped answering with its envelope\n%s\n' "$response" >&2; failed=1; }

  if (( failed == 0 )); then pass check_tool_answers_with_one_sentence
  else fail check_tool_answers_with_one_sentence; fi
}

CASE_TESTS+=(test_check_reports_current_behind_and_unknown test_check_refuses_without_gh
  test_check_refuses_when_gh_is_not_logged_in test_check_refuses_without_a_lock
  test_check_last_prints_the_result_without_asking_github
  test_check_last_refuses_what_it_cannot_read
  test_check_tool_reports_a_failure_as_a_tool_error
  test_check_result_tool_reads_the_last_check
  test_check_tool_answers_with_one_sentence)
