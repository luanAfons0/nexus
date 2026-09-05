# ui subcommand. Serve the Web UI from a Python 3 stdlib server bound to
# 127.0.0.1, the one network listener Nexus opens (ADR 0005). This file only
# parses the flags and hands over to scripts/lib/ui_server.py with exec, so
# the server owns the process, its signals, and its exit code. The server
# never touches a file itself: every read and mutation on the page is a
# subprocess call to this CLI.

# The CLI the server runs for every request. Tests override this to inject
# faults into the child; the real path is the script that is running now.
ui_cli_path() {
  printf '%s\n' "$NEXUS_SCRIPTS_DIR/nexus"
}

parse_ui_args() {
  UI_PORT=0
  UI_OPEN=true
  while (( $# != 0 )); do
    case "$1" in
      --port)
        if (( $# < 2 )) || [[ ! "$2" =~ ^[0-9]{1,5}$ ]] || (( 10#$2 > 65535 )); then
          error "ui: --port requires a number from 0 to 65535"
          usage >&2
          return 2
        fi
        UI_PORT=$(( 10#$2 ))
        shift 2 ;;
      --no-open)
        UI_OPEN=false
        shift ;;
      *)
        error "ui accepts only --port <N> and --no-open"
        usage >&2
        return 2 ;;
    esac
  done
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
  if [[ ! -f "$web/index.html" ]]; then
    error "web directory is absent or incomplete: $web"
    return 1
  fi
  cli="$(ui_cli_path)"
  argv=(python3 "$NEXUS_SCRIPTS_DIR/lib/ui_server.py"
        --port "$UI_PORT" --cli "$cli" --web "$web"
        --timeout "${NEXUS_UI_TIMEOUT:-300}")
  [[ "$UI_OPEN" == true ]] || argv+=(--no-open)
  exec "${argv[@]}"
}
