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
