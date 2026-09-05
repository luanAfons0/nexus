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

EMPTY_SHA256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

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

# sha256 of the current Global Instructions. An absent file hashes as the
# empty string, so one --if-match rule covers "I expect no file yet" and "I
# expect an empty file" alike.
global_current_sha256() {
  if global_instructions_present; then
    global_sha256 "$GLOBAL_INSTRUCTIONS"
  else
    printf '%s\n' "$EMPTY_SHA256"
  fi
}

parse_global_edit_args() {
  GLOBAL_IF_MATCH=''
  while (( $# != 0 )); do
    case "$1" in
      --if-match)
        if (( $# < 2 )); then
          error "global edit: --if-match requires a sha256 value"
          usage >&2
          return 2
        fi
        if [[ ! "$2" =~ ^[0-9a-fA-F]{64}$ ]]; then
          error "global edit: --if-match requires a hex sha256, got: $2"
          usage >&2
          return 2
        fi
        GLOBAL_IF_MATCH="${2,,}"
        shift 2 ;;
      *)
        error "global edit accepts only --if-match <sha256>"
        usage >&2
        return 2 ;;
    esac
  done
  return 0
}

# Replace the Global Instructions from stdin. Every refusal happens before
# the temporary file exists, so a refused edit leaves the Custom Root
# byte-identical. The write is a temporary file beside the Owner plus one
# rename, so a crash cannot leave a half file at the Owner path. When the
# Owner did not exist before, link runs afterward through the same path as
# `nexus link`, so both Instruction Paths point at the new file at once.
global_edit() {
  local existed=false current mode tmp
  parse_global_edit_args "$@" || return $?
  global_preflight || return 1
  global_instructions_present && existed=true
  if [[ -n "$GLOBAL_IF_MATCH" ]]; then
    current="$(global_current_sha256)" || return 1
    if [[ "$current" != "$GLOBAL_IF_MATCH" ]]; then
      error "global instructions changed since they were read: expected sha256 $GLOBAL_IF_MATCH, actual $current"
      return 1
    fi
  fi

  tmp="$(mktemp -- "$CUSTOM_ROOT/.nexus-tmp.global.XXXXXX")" || {
    error "cannot create a temporary file in the custom skill root: $CUSTOM_ROOT"
    return 1
  }
  if ! cat >"$tmp"; then
    rm -f -- "$tmp"
    error "cannot read the new global instructions from stdin"
    return 1
  fi
  if [[ "$existed" == true ]]; then
    mode="$(stat -c '%a' -- "$GLOBAL_INSTRUCTIONS")" || mode=''
  fi
  if [[ -z "${mode:-}" ]]; then
    mode="$(printf '%o' "$(( 0666 & ~0$(umask) ))")"
  fi
  chmod -- "$mode" "$tmp" || { rm -f -- "$tmp"; error "cannot set the mode of $tmp"; return 1; }
  if ! mv -f -- "$tmp" "$GLOBAL_INSTRUCTIONS"; then
    rm -f -- "$tmp"
    error "cannot replace the global instructions: $GLOBAL_INSTRUCTIONS"
    return 1
  fi
  [[ "$existed" == true ]] && return 0
  link_all false
}

global_command() {
  local action="${1:-}"
  case "$action" in
    show)
      global_show "${@:2}" ;;
    edit)
      global_edit "${@:2}" ;;
    *)
      usage >&2
      return 2 ;;
  esac
}
