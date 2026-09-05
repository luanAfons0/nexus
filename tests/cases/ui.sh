# Web UI tests. Every case starts `nexus ui` as a subprocess against an
# isolated fake HOME/NEXUS_HOME with `--port 0 --no-open`, reads the port
# and the Run Token from the handshake line, calls the server with Python's
# urllib, and asserts on the HTTP status, the JSON envelope, and the
# filesystem. No case inspects Python internals or page DOM.

UI_CLIENT="$REPO_ROOT/tests/ui_client.py"

# A fake home with the Custom Root, both Agent Homes, and the web files
# copied beside the Control Skills, as they live in the real Nexus home.
ui_home() {
  local home
  home="$(custom_home "$1")" || return 1
  cp -R -- "$REPO_ROOT/web" "$home/.nexus/" || return 1
  printf '%s\n' "$home"
}

# Start the server in the background and wait for the handshake line.
# Sets UI_PID, UI_URL (base URL with the token), UI_PORT, UI_TOKEN.
ui_start() {
  local home="$1"; shift
  local i line=''
  UI_PID=''; UI_URL=''; UI_PORT=''; UI_TOKEN=''
  start_nexus_overridden "$home" "${UI_FAULT:-}" "$home/ui-output" ui --port 0 --no-open "$@" || return 1
  UI_PID="$NEXUS_TEST_PID"
  for i in {1..300}; do
    line="$(head -n 1 -- "$home/ui-output" 2>/dev/null)"
    [[ -n "$line" ]] && break
    kill -0 "$UI_PID" 2>/dev/null || break
    sleep .02
  done
  [[ "$line" =~ ^nexus\ ui:\ (http://127\.0\.0\.1:([0-9]+)/t/([0-9a-f]{32})/)$ ]] || {
    printf '  no handshake line; output:\n' >&2; cat -- "$home/ui-output" >&2; return 1;
  }
  UI_URL="${BASH_REMATCH[1]}"; UI_PORT="${BASH_REMATCH[2]}"; UI_TOKEN="${BASH_REMATCH[3]}"
  return 0
}

ui_stop() {
  [[ -n "${UI_PID:-}" ]] || return 0
  stop_and_reap "$UI_PID"
  UI_PID=''
}

# ui_http METHOD URL [client flags...]; prints the client output.
ui_http() {
  python3 "$UI_CLIENT" "$@"
}

ui_status() {
  printf '%s\n' "$1" | head -n 1 | sed 's/^HTTP //'
}

ui_body() {
  printf '%s\n' "$1" | sed '1,/^$/d'
}

ui_header() {
  local response="$1" name="$2"
  printf '%s\n' "$response" | sed '/^$/q' | sed -n "s/^${name}: //p"
}

test_ui_handshake_and_stop() {
  local failed=0 home status
  home="$(ui_home ui_handshake)" || { fail ui_handshake_and_stop; return; }
  ui_start "$home" || failed=1
  [[ "$(head -n 1 -- "$home/ui-output")" == "nexus ui: http://127.0.0.1:$UI_PORT/t/$UI_TOKEN/" ]] || failed=1
  [[ "$(wc -l <"$home/ui-output")" -eq 1 ]] || { printf '  extra output before requests:\n' >&2; cat -- "$home/ui-output" >&2; failed=1; }
  ui_stop; status="$NEXUS_WAIT_STATUS"
  [[ "$status" -eq 0 ]] || { printf '  SIGTERM exit status: %s\n' "$status" >&2; failed=1; }
  ! pgrep -f -- "$home/.nexus/web" >/dev/null || { printf '  server process left behind\n' >&2; failed=1; }
  [[ "$(ui_status "$(ui_http GET "$UI_URL")")" == 0 ]] || { printf '  port still answers after stop\n' >&2; failed=1; }
  if (( failed == 0 )); then pass ui_handshake_and_stop; else fail ui_handshake_and_stop; fi
}

test_ui_static_allowlist() {
  local failed=0 home response
  home="$(ui_home ui_static)" || { fail ui_static_allowlist; return; }
  ui_start "$home" || failed=1

  response="$(ui_http GET "$UI_URL")"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  index status: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  [[ "$(ui_body "$response")" == *'<title>Nexus</title>'* ]] || { printf '  index body is not the page shell\n' >&2; failed=1; }
  [[ "$(ui_header "$response" cache-control)" == 'no-store' ]] || { printf '  missing Cache-Control: no-store\n' >&2; failed=1; }
  [[ "$(ui_header "$response" content-security-policy)" == "default-src 'self'" ]] || { printf '  missing CSP\n' >&2; failed=1; }
  [[ "$(ui_header "$response" content-type)" == 'text/html; charset=utf-8' ]] || failed=1

  response="$(ui_http GET "${UI_URL}index.html")"
  [[ "$(ui_status "$response")" == 200 ]] || failed=1
  response="$(ui_http GET "${UI_URL}app.css")"
  [[ "$(ui_status "$response")" == 200 && "$(ui_header "$response" content-type)" == 'text/css; charset=utf-8' ]] || failed=1
  response="$(ui_http GET "${UI_URL}app.js")"
  [[ "$(ui_status "$response")" == 200 && "$(ui_header "$response" content-type)" == 'text/javascript; charset=utf-8' ]] || failed=1

  # Outside the allowlist: a real file in the web directory, a directory,
  # a path that climbs out, and the CLI itself.
  printf 'secret\n' >"$home/.nexus/web/notes.txt"
  for path in notes.txt vendor vendor/ ../scripts/nexus ../../skill-lock.json ../skills/nexus/SKILL.md 'app.js/..' api/nothing; do
    response="$(ui_http GET "${UI_URL}${path}")"
    [[ "$(ui_status "$response")" == 404 ]] || { printf '  %s: status %s\n' "$path" "$(ui_status "$response")" >&2; failed=1; }
    [[ "$(ui_body "$response")" != *secret* && "$(ui_body "$response")" != *'#!/usr/bin/env bash'* ]] || failed=1
  done
  ui_stop
  if (( failed == 0 )); then pass ui_static_allowlist; else fail ui_static_allowlist; fi
}

test_ui_loopback_guard() {
  local failed=0 home response bare
  home="$(ui_home ui_guard)" || { fail ui_loopback_guard; return; }
  ui_start "$home" || failed=1
  bare="http://127.0.0.1:$UI_PORT"

  response="$(ui_http GET "$bare/")"
  [[ "$(ui_status "$response")" == 403 && "$(ui_body "$response")" == token ]] || { printf '  missing token: %s\n' "$response" >&2; failed=1; }
  response="$(ui_http GET "$bare/t/00000000000000000000000000000000/")"
  [[ "$(ui_status "$response")" == 403 && "$(ui_body "$response")" == token ]] || failed=1
  response="$(ui_http GET "$bare/t/$UI_TOKEN")"
  [[ "$(ui_status "$response")" == 403 && "$(ui_body "$response")" == token ]] || failed=1

  response="$(ui_http GET "$UI_URL" -H "Host: example.com:$UI_PORT")"
  [[ "$(ui_status "$response")" == 403 && "$(ui_body "$response")" == host ]] || { printf '  wrong Host: %s\n' "$response" >&2; failed=1; }
  response="$(ui_http GET "$UI_URL" -H "Host: 127.0.0.1:1")"
  [[ "$(ui_status "$response")" == 403 && "$(ui_body "$response")" == host ]] || failed=1
  response="$(ui_http GET "$UI_URL" -H "Host: localhost:$UI_PORT")"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  localhost Host refused\n' >&2; failed=1; }

  response="$(ui_http GET "$UI_URL" -H "Origin: http://evil.example")"
  [[ "$(ui_status "$response")" == 403 && "$(ui_body "$response")" == origin ]] || { printf '  foreign Origin: %s\n' "$response" >&2; failed=1; }
  response="$(ui_http GET "$UI_URL" -H "Origin: http://127.0.0.1:$UI_PORT")"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  same Origin refused\n' >&2; failed=1; }
  response="$(ui_http GET "$UI_URL" -H "Origin: null")"
  [[ "$(ui_status "$response")" == 403 && "$(ui_body "$response")" == origin ]] || failed=1

  # Host is checked before Origin and before the token.
  response="$(ui_http GET "$bare/" -H "Host: example.com:$UI_PORT" -H "Origin: http://evil.example")"
  [[ "$(ui_status "$response")" == 403 && "$(ui_body "$response")" == host ]] || failed=1
  ui_stop
  if (( failed == 0 )); then pass ui_loopback_guard; else fail ui_loopback_guard; fi
}

test_ui_cli_usage_and_port() {
  local failed=0 home output status
  home="$(ui_home ui_usage)" || { fail ui_cli_usage_and_port; return; }
  output="$(run_nexus "$home" ui --bogus 2>&1)"; status=$?
  [[ "$status" -eq 2 && "$output" == *'Usage: nexus'* ]] || { printf '  --bogus: %s %s\n' "$status" "$output" >&2; failed=1; }
  output="$(run_nexus "$home" ui --port 2>&1)"; status=$?
  [[ "$status" -eq 2 ]] || failed=1
  output="$(run_nexus "$home" ui --port abc 2>&1)"; status=$?
  [[ "$status" -eq 2 ]] || failed=1
  output="$(run_nexus "$home" ui extra 2>&1)"; status=$?
  [[ "$status" -eq 2 ]] || failed=1
  output="$(run_nexus "$home" help 2>&1)"
  [[ "$output" =~ (^|$'\n')ui\ +Serve\ the\ local\ web\ page:\ ui\ \[--port\ N\]\ \[--no-open\]\.($|$'\n') ]] || { printf '  help lacks the ui line\n' >&2; failed=1; }

  # --port N binds that port; a second server on the same port fails with 1.
  ui_start "$home" || failed=1
  output="$(run_nexus "$home" ui --port "$UI_PORT" --no-open 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *"$UI_PORT"* ]] || { printf '  bind failure: %s %s\n' "$status" "$output" >&2; failed=1; }
  ui_stop

  # A missing web directory is a refusal before any listener opens.
  rm -rf -- "$home/.nexus/web"
  output="$(run_nexus "$home" ui --no-open 2>&1)"; status=$?
  [[ "$status" -eq 1 && "$output" == *'web directory'* ]] || { printf '  missing web: %s %s\n' "$status" "$output" >&2; failed=1; }
  if (( failed == 0 )); then pass ui_cli_usage_and_port; else fail ui_cli_usage_and_port; fi
}

CASE_TESTS+=(
  test_ui_handshake_and_stop
  test_ui_static_allowlist
  test_ui_loopback_guard
  test_ui_cli_usage_and_port
)

# Ticket #29: GET api/list runs `nexus list --json` and answers the envelope.

test_ui_list_present() {
  local failed=0 home response body expected cli
  home="$(ui_home ui_list_present)" || { fail ui_list_present; return; }
  write_skill "$home/.agents/skills" alpha
  write_skill "$home/.custom-skills" mine
  write_lock "$home/.nexus/skill-lock.json" alpha
  printf 'rule one\n' >"$home/.custom-skills/GLOBAL.md"
  expected="$(run_nexus "$home" list --json)" || failed=1
  ui_start "$home" || failed=1

  response="$(ui_http GET "${UI_URL}api/list")"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  list status: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  [[ "$(ui_header "$response" content-type)" == 'application/json; charset=utf-8' ]] || failed=1
  [[ "$(ui_header "$response" cache-control)" == 'no-store' ]] || failed=1
  body="$(ui_body "$response")"
  jq -e '.exit == 0 and .stderr == "" and (.json | type) == "object"' <<<"$body" >/dev/null || { printf '  envelope:\n%s\n' "$body" >&2; failed=1; }
  cli="$REPO_ROOT/scripts/nexus"
  [[ "$(jq -c .command <<<"$body")" == "$(jq -c -n --arg cli "$cli" '[$cli, "list", "--json"]')" ]] || { printf '  command: %s\n' "$(jq -c .command <<<"$body")" >&2; failed=1; }
  [[ "$(jq -c .json.skills <<<"$body")" == "$(jq -c .skills <<<"$expected")" ]] || { printf '  json.skills differs from the CLI\n' >&2; failed=1; }
  [[ "$(jq -c .json.globalInstructions <<<"$body")" == "$(jq -c .globalInstructions <<<"$expected")" ]] || failed=1
  [[ "$(jq -c .stdout <<<"$body")" == "$(jq -c -n --arg s "$expected"$'\n' '$s')" ]] || { printf '  stdout is not the CLI bytes\n' >&2; failed=1; }
  [[ "$(jq -r '.json.skills[] | select(.name == "alpha") | .kind' <<<"$body")" == installed ]] || failed=1
  [[ "$(jq -r '.json.skills[] | select(.name == "mine") | .kind' <<<"$body")" == custom ]] || failed=1
  [[ "$(jq -r '.json.skills[] | select(.name == "nexus") | .kind' <<<"$body")" == control ]] || failed=1

  # Only GET is an API method for list.
  response="$(ui_http POST "${UI_URL}api/list" -H 'Content-Type: application/json' -d '{}')"
  [[ "$(ui_status "$response")" == 404 ]] || { printf '  POST list: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  ui_stop
  if (( failed == 0 )); then pass ui_list_present; else fail ui_list_present; fi
}

test_ui_list_lock_absent() {
  local failed=0 home response body
  home="$(ui_home ui_list_absent)" || { fail ui_list_lock_absent; return; }
  write_skill "$home/.custom-skills" only-custom
  ui_start "$home" || failed=1

  response="$(ui_http GET "${UI_URL}api/list")"
  [[ "$(ui_status "$response")" == 200 ]] || failed=1
  body="$(ui_body "$response")"
  jq -e '.exit == 0' <<<"$body" >/dev/null || { printf '  envelope:\n%s\n' "$body" >&2; failed=1; }
  [[ "$(jq -r .stderr <<<"$body")" == "nexus: lock is absent: $home/.nexus/skill-lock.json" ]] || { printf '  stderr: %s\n' "$(jq -r .stderr <<<"$body")" >&2; failed=1; }
  [[ "$(jq -r '[.json.skills[].kind] | unique | join(",")' <<<"$body")" == 'control,custom' ]] || { printf '  kinds: %s\n' "$(jq -c '[.json.skills[].kind]' <<<"$body")" >&2; failed=1; }
  [[ "$(jq -r '.json.skills | length' <<<"$body")" -eq 9 ]] || failed=1
  [[ ! -e "$home/.nexus/skill-lock.json" ]] || { printf '  list created a lock\n' >&2; failed=1; }
  ui_stop
  if (( failed == 0 )); then pass ui_list_lock_absent; else fail ui_list_lock_absent; fi
}

CASE_TESTS+=(
  test_ui_list_present
  test_ui_list_lock_absent
)

# Ticket #32: POST api/update and api/remove, one mutation at a time, timeout.

test_ui_remove_refusals_pass_argv_through() {
  local failed=0 home response body before after cli
  home="$(ui_home ui_remove_refusals)" || { fail ui_remove_refusals_pass_argv_through; return; }
  write_skill "$home/.agents/skills" alpha
  write_skill "$home/.custom-skills" mine
  write_lock "$home/.nexus/skill-lock.json" alpha
  run_nexus "$home" link >/dev/null 2>&1 || failed=1
  mkdir -p -- "$home/fakebin"
  printf '%s\n' '#!/usr/bin/env bash' ': >"$HOME/npx-invoked"' >"$home/fakebin/npx"; chmod 755 "$home/fakebin/npx"
  cli="$REPO_ROOT/scripts/nexus"
  before="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.agents")|$(cat "$home/.nexus/skill-lock.json")"
  PATH="$home/fakebin:$PATH" ui_start "$home" || failed=1

  # A Control Skill name: the CLI refuses, exit 1 in the envelope, HTTP 200.
  response="$(ui_http POST "${UI_URL}api/remove" -H 'Content-Type: application/json' -d '{"name":"nexus"}')"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  control remove status: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  body="$(ui_body "$response")"
  # The CLI treats a control name as a usage fault (exit 2); the envelope
  # carries the CLI's exit code and message as they are.
  jq -e '.exit == 2 and (.stderr | contains("reserved control skill name: nexus")) and (has("json") | not)' <<<"$body" >/dev/null || { printf '  control remove envelope:\n%s\n' "$body" >&2; failed=1; }
  [[ "$(jq -c .command <<<"$body")" == "$(jq -c -n --arg cli "$cli" '[$cli, "remove", "nexus"]')" ]] || { printf '  command: %s\n' "$(jq -c .command <<<"$body")" >&2; failed=1; }

  # A name that is not installed, and a Custom Skill name.
  response="$(ui_http POST "${UI_URL}api/remove" -H 'Content-Type: application/json' -d '{"name":"missing"}')"
  jq -e '.exit == 1' <<<"$(ui_body "$response")" >/dev/null || { printf '  missing name: %s\n' "$response" >&2; failed=1; }
  response="$(ui_http POST "${UI_URL}api/remove" -H 'Content-Type: application/json' -d '{"name":"mine"}')"
  jq -e '.exit == 1' <<<"$(ui_body "$response")" >/dev/null || { printf '  custom name: %s\n' "$response" >&2; failed=1; }

  # An unsafe name reaches the CLI as one argv element and is refused there.
  response="$(ui_http POST "${UI_URL}api/update" -H 'Content-Type: application/json' -d '{"name":"../escape; touch pwned"}')"
  body="$(ui_body "$response")"
  [[ "$(ui_status "$response")" == 200 ]] || failed=1
  [[ "$(jq -c .command <<<"$body")" == "$(jq -c -n --arg cli "$cli" '[$cli, "update", "../escape; touch pwned"]')" ]] || { printf '  unsafe argv: %s\n' "$(jq -c .command <<<"$body")" >&2; failed=1; }
  jq -e '.exit != 0' <<<"$body" >/dev/null || failed=1
  [[ ! -e "$home/pwned" && ! -e "$REPO_ROOT/pwned" ]] || { printf '  shell evaluated the name\n' >&2; failed=1; }

  # Wrong content type, a body that is not an object, and a missing name.
  response="$(ui_http POST "${UI_URL}api/remove" -H 'Content-Type: text/plain' -d '{"name":"alpha"}')"
  [[ "$(ui_status "$response")" == 415 && "$(ui_body "$response")" == json ]] || { printf '  text/plain: %s\n' "$response" >&2; failed=1; }
  response="$(ui_http POST "${UI_URL}api/remove" -d '{"name":"alpha"}')"
  [[ "$(ui_status "$response")" == 415 ]] || { printf '  no content type: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  response="$(ui_http POST "${UI_URL}api/remove" -H 'Content-Type: application/json' -d '[1]')"
  [[ "$(ui_status "$response")" == 400 ]] || { printf '  array body: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  response="$(ui_http POST "${UI_URL}api/remove" -H 'Content-Type: application/json' -d '{}')"
  [[ "$(ui_status "$response")" == 400 ]] || { printf '  missing name: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  response="$(ui_http OPTIONS "${UI_URL}api/remove" -H 'Origin: http://evil.example' -H 'Access-Control-Request-Method: POST')"
  [[ "$(ui_status "$response")" == 403 ]] || { printf '  preflight answered: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  response="$(ui_http GET "${UI_URL}api/remove")"
  [[ "$(ui_status "$response")" == 404 ]] || failed=1

  ui_stop
  after="$(snapshot_tree "$home/.claude")|$(snapshot_tree "$home/.codex")|$(snapshot_tree "$home/.agents")|$(cat "$home/.nexus/skill-lock.json")"
  [[ "$before" == "$after" ]] || { printf '  a refused mutation changed a tree\n' >&2; failed=1; }
  [[ ! -e "$home/npx-invoked" ]] || { printf '  upstream npx ran for a refusal\n' >&2; failed=1; }
  if (( failed == 0 )); then pass ui_remove_refusals_pass_argv_through; else fail ui_remove_refusals_pass_argv_through; fi
}

test_ui_one_mutation_at_a_time() {
  local failed=0 home response body i
  home="$(ui_home ui_mutation_lock)" || { fail ui_one_mutation_at_a_time; return; }
  write_skill "$home/.agents/skills" alpha
  write_lock "$home/.nexus/skill-lock.json" alpha
  UI_FAULT=ui_slow_child ui_start "$home" || failed=1

  ui_http POST "${UI_URL}api/update" -H 'Content-Type: application/json' -d '{"name":"alpha"}' >"$home/first-response" &
  local first=$!
  for i in {1..200}; do [[ -e "$home/child-started" ]] && break; sleep .02; done
  [[ -e "$home/child-started" ]] || { printf '  slow child never started\n' >&2; failed=1; }

  # A second mutation is refused while the first runs; reads are not locked.
  response="$(ui_http POST "${UI_URL}api/remove" -H 'Content-Type: application/json' -d '{"name":"alpha"}')"
  [[ "$(ui_status "$response")" == 409 && "$(ui_body "$response")" == busy ]] || { printf '  second mutation: %s\n' "$response" >&2; failed=1; }
  response="$(ui_http GET "${UI_URL}api/list")"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  read during mutation: %s\n' "$(ui_status "$response")" >&2; failed=1; }

  : >"$home/child-release"
  wait "$first" || failed=1
  body="$(ui_body "$(cat "$home/first-response")")"
  jq -e '.exit == 0 and (.stdout | contains("slow child finished"))' <<<"$body" >/dev/null || { printf '  first response:\n%s\n' "$body" >&2; failed=1; }

  # The lock is released: the same call now runs again.
  rm -f -- "$home/child-started"; : >"$home/child-release"
  response="$(ui_http POST "${UI_URL}api/update" -H 'Content-Type: application/json' -d '{"name":"alpha"}')"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  after release: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  ui_stop
  if (( failed == 0 )); then pass ui_one_mutation_at_a_time; else fail ui_one_mutation_at_a_time; fi
}

test_ui_child_timeout() {
  local failed=0 home response body
  home="$(ui_home ui_timeout)" || { fail ui_child_timeout; return; }
  write_skill "$home/.agents/skills" alpha
  write_lock "$home/.nexus/skill-lock.json" alpha
  NEXUS_UI_TIMEOUT=1 UI_FAULT=ui_timeout_child ui_start "$home" || failed=1

  response="$(ui_http POST "${UI_URL}api/update" -H 'Content-Type: application/json' -d '{"name":"alpha"}')"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  timeout status: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  body="$(ui_body "$response")"
  jq -e '.exit == 124 and (.stderr | contains("timeout")) and (.stderr | contains("1"))' <<<"$body" >/dev/null || { printf '  timeout envelope:\n%s\n' "$body" >&2; failed=1; }
  ! pgrep -f -- "$REPO_ROOT/tests/faults.sh update alpha" >/dev/null || { printf '  timed-out child still runs\n' >&2; failed=1; }

  # The lock is released after a timeout.
  response="$(ui_http POST "${UI_URL}api/remove" -H 'Content-Type: application/json' -d '{"name":"nexus"}')"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  after timeout: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  ui_stop
  if (( failed == 0 )); then pass ui_child_timeout; else fail ui_child_timeout; fi
}

test_ui_stop_kills_running_child() {
  local failed=0 home i status
  home="$(ui_home ui_stop_child)" || { fail ui_stop_kills_running_child; return; }
  write_skill "$home/.agents/skills" alpha
  write_lock "$home/.nexus/skill-lock.json" alpha
  UI_FAULT=ui_slow_child ui_start "$home" || failed=1
  ui_http POST "${UI_URL}api/update" -H 'Content-Type: application/json' -d '{"name":"alpha"}' >/dev/null 2>&1 &
  local request=$!
  for i in {1..200}; do [[ -e "$home/child-started" ]] && break; sleep .02; done
  [[ -e "$home/child-started" ]] || failed=1
  pgrep -f -- "$REPO_ROOT/tests/faults.sh update alpha" >/dev/null || { printf '  child not visible before the stop\n' >&2; failed=1; }
  ui_stop; status="$NEXUS_WAIT_STATUS"
  [[ "$status" -eq 0 ]] || { printf '  stop status with a child: %s\n' "$status" >&2; failed=1; }
  wait "$request" 2>/dev/null || :
  for i in {1..100}; do pgrep -f -- "$REPO_ROOT/tests/faults.sh update alpha" >/dev/null || break; sleep .02; done
  ! pgrep -f -- "$REPO_ROOT/tests/faults.sh update alpha" >/dev/null || { printf '  CLI child survived the stop\n' >&2; failed=1; }
  if (( failed == 0 )); then pass ui_stop_kills_running_child; else fail ui_stop_kills_running_child; fi
}

CASE_TESTS+=(
  test_ui_remove_refusals_pass_argv_through
  test_ui_one_mutation_at_a_time
  test_ui_child_timeout
  test_ui_stop_kills_running_child
)

# Ticket #30: GET api/global and the vendored renderer.

test_ui_api_global_present() {
  local failed=0 home response expected_sha
  home="$(ui_home ui_global_present)" || { fail ui_api_global_present; return; }
  printf 'rule one\n\nrule two' >"$home/.custom-skills/GLOBAL.md"
  ln -s -- ../.custom-skills/GLOBAL.md "$home/.claude/CLAUDE.md"
  printf 'hand written\n' >"$home/.codex/AGENTS.md"
  expected_sha="$(sha256sum <"$home/.custom-skills/GLOBAL.md" | awk '{print $1}')"
  ui_start "$home" || failed=1

  response="$(ui_http GET "${UI_URL}api/global")"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  status %s\n' "$(ui_status "$response")" >&2; failed=1; }
  [[ "$(ui_header "$response" content-type)" == 'application/json; charset=utf-8' ]] || failed=1
  [[ "$(ui_header "$response" cache-control)" == 'no-store' ]] || failed=1
  ui_body "$response" | jq -e --arg cli "$REPO_ROOT/scripts/nexus" --arg sha "$expected_sha" \
    --arg owner "$home/.custom-skills/GLOBAL.md" '
    .exit == 0 and .command == [$cli, "global", "show", "--json"] and .stderr == "" and
    (.stdout | fromjson) == .json and
    .json.owner == $owner and .json.present == true and .json.sha256 == $sha and
    .json.content == "rule one\n\nrule two" and .json.claude == "linked" and .json.codex == "foreign"
  ' >/dev/null || { printf '  unexpected envelope:\n%s\n' "$(ui_body "$response")" >&2; failed=1; }
  [[ "$(cat "$home/.codex/AGENTS.md")" == 'hand written' ]] || failed=1
  ui_stop
  if (( failed == 0 )); then pass ui_api_global_present; else fail ui_api_global_present; fi
}

test_ui_api_global_absent_and_fault() {
  local failed=0 home response
  home="$(ui_home ui_global_absent)" || { fail ui_api_global_absent_and_fault; return; }
  rm -rf -- "$home/.codex"
  ui_start "$home" || failed=1

  response="$(ui_http GET "${UI_URL}api/global")"
  [[ "$(ui_status "$response")" == 200 ]] || failed=1
  ui_body "$response" | jq -e --arg owner "$home/.custom-skills/GLOBAL.md" '
    .exit == 0 and .json.present == false and .json.sha256 == null and .json.content == null and
    .json.owner == $owner and .json.claude == "absent" and .json.codex == "no home"
  ' >/dev/null || { printf '  unexpected absent envelope:\n%s\n' "$(ui_body "$response")" >&2; failed=1; }
  [[ ! -e "$home/.custom-skills/GLOBAL.md" && ! -e "$home/.codex" ]] || { printf '  show created a path\n' >&2; failed=1; }

  # A CLI refusal is exit 1 in the envelope, not an HTTP error, and no json key.
  rm -rf -- "$home/.custom-skills"
  response="$(ui_http GET "${UI_URL}api/global")"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  fault status %s\n' "$(ui_status "$response")" >&2; failed=1; }
  ui_body "$response" | jq -e --arg root "$home/.custom-skills" '
    .exit == 1 and (has("json") | not) and .stdout == "" and
    (.stderr | contains("error: custom skill root is absent: " + $root))
  ' >/dev/null || { printf '  unexpected fault envelope:\n%s\n' "$(ui_body "$response")" >&2; failed=1; }
  [[ ! -e "$home/.custom-skills" ]] || failed=1
  ui_stop
  if (( failed == 0 )); then pass ui_api_global_absent_and_fault; else fail ui_api_global_absent_and_fault; fi
}

test_ui_vendored_renderer_served() {
  local failed=0 home response
  home="$(ui_home ui_renderer)" || { fail ui_vendored_renderer_served; return; }
  ui_start "$home" || failed=1
  response="$(ui_http GET "${UI_URL}vendor/marked.min.js")"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  status %s\n' "$(ui_status "$response")" >&2; failed=1; }
  [[ "$(ui_header "$response" content-type)" == 'text/javascript; charset=utf-8' ]] || failed=1
  [[ "$(ui_header "$response" content-security-policy)" == "default-src 'self'" ]] || failed=1
  [[ "$(ui_body "$response")" == *'marked v15.0.12'* ]] || { printf '  renderer body lacks the version header\n' >&2; failed=1; }
  { [[ -f "$REPO_ROOT/web/vendor/LICENSE" ]] && grep -q 'MIT' "$REPO_ROOT/web/vendor/LICENSE"; } || { printf '  vendor LICENSE missing\n' >&2; failed=1; }
  response="$(ui_http GET "${UI_URL}vendor/LICENSE")"
  [[ "$(ui_status "$response")" == 404 ]] || failed=1
  ui_stop
  if (( failed == 0 )); then pass ui_vendored_renderer_served; else fail ui_vendored_renderer_served; fi
}

CASE_TESTS+=(
  test_ui_api_global_present
  test_ui_api_global_absent_and_fault
  test_ui_vendored_renderer_served
)

# Ticket #31: PUT api/global runs `nexus global edit --if-match` with the
# body content on standard input.

ui_put_global() {
  local url="$1" content="$2" if_match="$3"
  ui_http PUT "${url}api/global" -H 'Content-Type: application/json' \
    -d "$(jq -c -n --arg content "$content" --arg ifMatch "$if_match" '{content: $content, ifMatch: $ifMatch}')"
}

ui_save_snapshot() {
  local home="$1"
  printf '%s|%s|%s\n' "$(snapshot_tree "$home/.custom-skills")" "$(snapshot_tree "$home/.claude")" "$(snapshot_tree "$home/.codex")"
}

test_ui_save_creates_and_links() {
  local failed=0 home response body cli
  home="$(ui_home ui_save_create)" || { fail ui_save_creates_and_links; return; }
  write_skill "$home/.agents/skills" alpha
  write_lock "$home/.nexus/skill-lock.json" alpha
  cli="$REPO_ROOT/scripts/nexus"
  ui_start "$home" || failed=1

  response="$(ui_put_global "$UI_URL" $'rule one\n\nrule two\n' e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855)"
  [[ "$(ui_status "$response")" == 200 ]] || { printf '  create status: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  body="$(ui_body "$response")"
  jq -e '.exit == 0 and (.stdout | contains("link complete"))' <<<"$body" >/dev/null || { printf '  create envelope:\n%s\n' "$body" >&2; failed=1; }
  [[ "$(jq -c .command <<<"$body")" == "$(jq -c -n --arg cli "$cli" '[$cli, "global", "edit", "--if-match", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]')" ]] || { printf '  command: %s\n' "$(jq -c .command <<<"$body")" >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == $'rule one\n\nrule two' && -f "$home/.custom-skills/GLOBAL.md" && ! -L "$home/.custom-skills/GLOBAL.md" ]] || { printf '  file bytes differ\n' >&2; failed=1; }
  assert_instruction_link "$home" "$home/.claude/CLAUDE.md" || failed=1
  assert_instruction_link "$home" "$home/.codex/AGENTS.md" || failed=1
  ui_stop
  if (( failed == 0 )); then pass ui_save_creates_and_links; else fail ui_save_creates_and_links; fi
}

test_ui_save_replaces_without_link() {
  local failed=0 home response body sha
  home="$(ui_home ui_save_replace)" || { fail ui_save_replaces_without_link; return; }
  write_skill "$home/.agents/skills" alpha
  write_lock "$home/.nexus/skill-lock.json" alpha
  printf 'old rule\n' >"$home/.custom-skills/GLOBAL.md"
  printf 'hand written\n' >"$home/.codex/AGENTS.md"
  sha="$(sha256sum <"$home/.custom-skills/GLOBAL.md" | awk '{print $1}')"
  ui_start "$home" || failed=1

  response="$(ui_put_global "$UI_URL" 'new rule' "$sha")"
  [[ "$(ui_status "$response")" == 200 ]] || failed=1
  body="$(ui_body "$response")"
  jq -e '.exit == 0 and .stdout == "" and .stderr == ""' <<<"$body" >/dev/null || { printf '  replace envelope:\n%s\n' "$body" >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md"; printf x)" == 'new rulex' ]] || { printf '  replaced bytes differ\n' >&2; failed=1; }
  [[ -f "$home/.codex/AGENTS.md" && ! -L "$home/.codex/AGENTS.md" && "$(cat "$home/.codex/AGENTS.md")" == 'hand written' ]] || { printf '  Foreign Entry was touched\n' >&2; failed=1; }
  [[ ! -e "$home/.claude/CLAUDE.md" && ! -L "$home/.claude/CLAUDE.md" ]] || { printf '  replace ran link\n' >&2; failed=1; }
  ui_stop
  if (( failed == 0 )); then pass ui_save_replaces_without_link; else fail ui_save_replaces_without_link; fi
}

test_ui_save_conflict_keeps_file() {
  local failed=0 home response body
  home="$(ui_home ui_save_conflict)" || { fail ui_save_conflict_keeps_file; return; }
  printf 'current rule\n' >"$home/.custom-skills/GLOBAL.md"
  ui_start "$home" || failed=1

  response="$(ui_put_global "$UI_URL" 'stale edit' e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855)"
  [[ "$(ui_status "$response")" == 200 ]] || failed=1
  body="$(ui_body "$response")"
  jq -e '.exit == 1 and (.stderr | contains("expected sha256 e3b0c442")) and (has("json") | not)' <<<"$body" >/dev/null || { printf '  conflict envelope:\n%s\n' "$body" >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == 'current rule' ]] || { printf '  conflict changed the file\n' >&2; failed=1; }
  ui_stop
  if (( failed == 0 )); then pass ui_save_conflict_keeps_file; else fail ui_save_conflict_keeps_file; fi
}

test_ui_save_refuses_bad_requests() {
  local failed=0 home response before after
  home="$(ui_home ui_save_bad)" || { fail ui_save_refuses_bad_requests; return; }
  printf 'current rule\n' >"$home/.custom-skills/GLOBAL.md"
  before="$(ui_save_snapshot "$home")"
  ui_start "$home" || failed=1

  response="$(ui_http PUT "${UI_URL}api/global" -H 'Content-Type: text/plain' -d '{"content":"x","ifMatch":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}')"
  [[ "$(ui_status "$response")" == 415 && "$(ui_body "$response")" == json ]] || { printf '  text/plain: %s\n' "$response" >&2; failed=1; }
  response="$(ui_http PUT "${UI_URL}api/global" -d '{"content":"x","ifMatch":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}')"
  [[ "$(ui_status "$response")" == 415 ]] || { printf '  no content type: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  response="$(ui_http PUT "${UI_URL}api/global" -H 'Content-Type: application/json' -d '["x"]')"
  [[ "$(ui_status "$response")" == 400 && "$(ui_body "$response")" == body ]] || { printf '  array body: %s\n' "$response" >&2; failed=1; }
  response="$(ui_http PUT "${UI_URL}api/global" -H 'Content-Type: application/json' -d '{"content":"x"}')"
  [[ "$(ui_status "$response")" == 400 ]] || { printf '  missing ifMatch: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  response="$(ui_http PUT "${UI_URL}api/global" -H 'Content-Type: application/json' -d 'not json')"
  [[ "$(ui_status "$response")" == 400 ]] || failed=1
  response="$(ui_http PUT "${UI_URL}api/list" -H 'Content-Type: application/json' -d '{}')"
  [[ "$(ui_status "$response")" == 404 ]] || { printf '  PUT list: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  response="$(ui_http OPTIONS "${UI_URL}api/global" -H 'Origin: http://evil.example' -H 'Access-Control-Request-Method: PUT')"
  [[ "$(ui_status "$response")" == 403 ]] || { printf '  preflight answered: %s\n' "$(ui_status "$response")" >&2; failed=1; }
  ui_stop
  after="$(ui_save_snapshot "$home")"
  [[ "$before" == "$after" ]] || { printf '  a refused request changed a tree\n' >&2; failed=1; }
  [[ "$(cat "$home/.custom-skills/GLOBAL.md")" == 'current rule' ]] || failed=1
  if (( failed == 0 )); then pass ui_save_refuses_bad_requests; else fail ui_save_refuses_bad_requests; fi
}

CASE_TESTS+=(
  test_ui_save_creates_and_links
  test_ui_save_replaces_without_link
  test_ui_save_conflict_keeps_file
  test_ui_save_refuses_bad_requests
)
