# ui subcommand. Serve the Web UI from a Python 3 stdlib server bound to
# 127.0.0.1, the one network listener Nexus opens (ADR 0005, revised in part
# by ADR 0006). This file only parses the flags and hands over to
# scripts/lib/ui_server.py with exec, so the server owns the process, its
# signals, and its exit code. The server never touches a file itself: every
# read and mutation on the page is a subprocess call to this CLI.
#
# A run detaches by default, so the terminal — and the agent session — is
# free as soon as the handshake line is printed. --foreground keeps the run
# in the terminal, where Ctrl-C and SIGTERM stop it.
#
# --status, --stop, and --open are whole modes, not flags on a run. --status
# and --stop read the Run File and confirm the recorded run over the
# loopback, never by pid, so no command signals a process it has not
# confirmed (ADR 0006). --open is the idempotent "show me the Web UI": it
# opens the recorded run when it answers, and otherwise starts one and opens
# that.

# The CLI the server runs for every request. Tests override this to inject
# faults into the child; the real path is the script that is running now.
ui_cli_path() {
  printf '%s\n' "$NEXUS_SCRIPTS_DIR/nexus"
}

# The Run File: the one live Web UI run, recorded in the Nexus home.
ui_run_file() {
  printf '%s\n' "$NEXUS_HOME/ui-run.json"
}

# Where a Detached Run writes its diagnostics, because it has no terminal.
# Truncated at each start.
ui_log_file() {
  printf '%s\n' "$NEXUS_HOME/ui.log"
}

parse_ui_args() {
  local run_flags=0 modes=0
  UI_PORT=0
  UI_OPEN=true
  UI_FOREGROUND=false
  UI_MODE=serve
  while (( $# != 0 )); do
    case "$1" in
      --port)
        if (( $# < 2 )) || [[ ! "$2" =~ ^[0-9]{1,5}$ ]] || (( 10#$2 > 65535 )); then
          error "ui: --port requires a number from 0 to 65535"
          usage >&2
          return 2
        fi
        UI_PORT=$(( 10#$2 ))
        run_flags=1
        shift 2 ;;
      --no-open)
        UI_OPEN=false
        run_flags=1
        shift ;;
      --foreground)
        UI_FOREGROUND=true
        run_flags=1
        shift ;;
      --status)
        UI_MODE=status
        modes=$(( modes + 1 ))
        shift ;;
      --stop)
        UI_MODE=stop
        modes=$(( modes + 1 ))
        shift ;;
      --open)
        UI_MODE=open
        modes=$(( modes + 1 ))
        shift ;;
      *)
        error "ui accepts only --port <N>, --no-open, --foreground, --status, --stop, and --open"
        usage >&2
        return 2 ;;
    esac
  done
  if (( modes > 1 || ( modes == 1 && run_flags == 1 ) )); then
    error "ui: --status, --stop, and --open are whole modes and take no other flag"
    usage >&2
    return 2
  fi
  return 0
}

ui_command() {
  local web cli
  local -a argv=()
  parse_ui_args "$@" || return $?
  command -v python3 >/dev/null 2>&1 || {
    error "required command not available: python3"
    return 1
  }
  web="$NEXUS_HOME/web"
  cli="$(ui_cli_path)"
  argv=(python3 "$NEXUS_SCRIPTS_DIR/lib/ui_server.py" --run-file "$(ui_run_file)")
  if [[ "$UI_MODE" == status || "$UI_MODE" == stop ]]; then
    # A question about the recorded run: it needs no page to serve.
    argv+=("--$UI_MODE")
    exec "${argv[@]}"
  fi
  if [[ ! -f "$web/index.html" ]]; then
    error "web directory is absent or incomplete: $web"
    return 1
  fi
  # --open is the asymmetry: it is a whole mode like the other two, but it
  # may end in a run, so it carries the full serve arguments rather than the
  # run-file-only list. Its defaults are a plain start with the browser
  # opened, which is exactly what it needs when no run answers.
  argv+=(--port "$UI_PORT" --cli "$cli" --web "$web"
         --log-file "$(ui_log_file)" --timeout "${NEXUS_UI_TIMEOUT:-300}")
  [[ "$UI_MODE" != open ]] || argv+=(--open)
  [[ "$UI_OPEN" == true ]] || argv+=(--no-open)
  [[ "$UI_FOREGROUND" == false ]] || argv+=(--foreground)
  exec "${argv[@]}"
}
