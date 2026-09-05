# global subcommand. Read and replace the Global Instructions, the one path
# in the Custom Root that Nexus writes (ADR 0004). Every refusal happens
# before any change, and output makes no terminal assumption, so a web page
# can drive the command through a subprocess.

# The Custom Root must exist and be a physical directory before Nexus reads
# or writes the Global Instructions. Nexus never creates the Custom Root.
global_custom_root_preflight() {
  if [[ ! -e "$CUSTOM_ROOT" && ! -L "$CUSTOM_ROOT" ]]; then
    error "custom skill root is absent: $CUSTOM_ROOT"
    return 1
  fi
  custom_root_preflight || return 1
  return 0
}

global_preflight() {
  global_custom_root_preflight || return 1
  global_instructions_preflight || return 1
  return 0
}

global_sha256() {
  sha256sum -- "$1" | awk '{ print $1 }'
}

# One JSON object for the Global Instructions: owner, present, sha256,
# content, and the two Instruction Path states as list reports them.
# $1 true includes content; false omits the key (list --json shape).
global_instructions_json() {
  local with_content="${1:-true}" present=false sha=null content_file=''
  local claude codex
  claude="$(instruction_path_state "$CLAUDE_INSTRUCTIONS")"
  codex="$(instruction_path_state "$CODEX_INSTRUCTIONS")"
  if global_instructions_present; then
    present=true
    sha="$(global_sha256 "$GLOBAL_INSTRUCTIONS")" || return 1
    content_file="$GLOBAL_INSTRUCTIONS"
  fi
  if [[ "$with_content" == true ]]; then
    if [[ -n "$content_file" ]]; then
      jq -c -Rs --arg owner "$GLOBAL_INSTRUCTIONS" --argjson present "$present" \
        --arg sha "$sha" --arg claude "$claude" --arg codex "$codex" '
        { owner: $owner, present: $present, sha256: $sha, content: .,
          claude: $claude, codex: $codex }' -- "$content_file"
    else
      jq -c -n --arg owner "$GLOBAL_INSTRUCTIONS" --arg claude "$claude" --arg codex "$codex" '
        { owner: $owner, present: false, sha256: null, content: null,
          claude: $claude, codex: $codex }'
    fi
  else
    jq -c -n --arg owner "$GLOBAL_INSTRUCTIONS" --argjson present "$present" \
      --arg sha "$sha" --arg claude "$claude" --arg codex "$codex" '
      { owner: $owner, present: $present,
        sha256: (if $present then $sha else null end),
        claude: $claude, codex: $codex }'
  fi
}

global_show() {
  local json=false arg
  for arg in "$@"; do
    case "$arg" in
      --json) json=true ;;
      *)
        error "global show accepts only --json"
        usage >&2
        return 2 ;;
    esac
  done
  global_preflight || return 1
  if [[ "$json" == true ]]; then
    global_instructions_json true || return 1
    return 0
  fi
  global_instructions_present || return 0
  cat -- "$GLOBAL_INSTRUCTIONS"
}

global_command() {
  local action="${1:-}"
  case "$action" in
    show)
      global_show "${@:2}" ;;
    *)
      usage >&2
      return 2 ;;
  esac
}
