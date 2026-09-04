parse_install_args() {
  local source='' name
  INSTALL_SOURCE=''
  INSTALL_SKILLS=()
  while (( $# != 0 )); do
    case "$1" in
      --skill)
        shift
        if (( $# == 0 )) || [[ "$1" == -* ]] || ! safe_skill_name "$1" || is_control_skill "$1"; then
          error "install requires --skill NAME with a safe, non-control skill name"
          return 2
        fi
        INSTALL_SKILLS+=("$1")
        ;;
      -*)
        error "unknown install flag: $1"
        return 2
        ;;
      *)
        if [[ -n "$source" ]]; then
          error "install accepts exactly one source"
          return 2
        fi
        source="$1"
        ;;
    esac
    shift
  done
  if [[ -z "$source" ]]; then
    error "install requires one source"
    return 2
  fi
  if (( ${#INSTALL_SKILLS[@]} == 0 )); then
    error "install requires at least one --skill NAME"
    return 2
  fi
  INSTALL_SOURCE="$source"
  return 0
}

ensure_npx() {
  command -v npx >/dev/null 2>&1 && return 0

  local nvm_dir="${NVM_DIR:-$HOME/.nvm}" nvm_script
  nvm_script="$nvm_dir/nvm.sh"
  [[ -f "$nvm_script" ]] || {
    error "npx is unavailable and NVM was not found"
    return 1
  }

  local had_nounset=0 status=0
  [[ "$-" == *u* ]] && had_nounset=1
  set +u
  # nvm.sh is third-party shell code and commonly references unset variables.
  source "$nvm_script" || status=$?
  if (( status == 0 )); then
    nvm use default >/dev/null 2>&1 || status=$?
  fi
  (( had_nounset )) && set -u
  if (( status != 0 )) || ! command -v npx >/dev/null 2>&1; then
    error "NVM loaded but npx is unavailable"
    return 1
  fi
  return 0
}

install_report_untracked() {
  local name target
  for name in "${INSTALL_SKILLS[@]}"; do
    target="$CANONICAL_DIR/$name"
    [[ -d "$target" ]] && info "untracked canonical skill directory: $target"
  done
}

install() {
  local status=0 name target
  local -a custom_names=()
  parse_install_args "$@" || return $?
  # Refuse a colliding name before the network call, so nothing is downloaded
  # and no upstream lock is rewritten for an install that cannot be linked.
  custom_root_preflight || return 1
  collect_custom_names custom_names || return 1
  local custom
  for name in "${INSTALL_SKILLS[@]}"; do
    for custom in "${custom_names[@]}"; do
      if [[ "$name" == "$custom" ]]; then
        error "install skill collides with a custom skill: $name ($CUSTOM_ROOT/$name)"
        return 1
      fi
    done
  done
  ensure_npx || return 1
  local -a lock_names=() command=(npx --yes skills add "$INSTALL_SOURCE" --global --agent universal)
  for name in "${INSTALL_SKILLS[@]}"; do
    command+=(--skill "$name")
  done
  command+=(--yes)

  env -u XDG_STATE_HOME "${command[@]}"
  status=$?
  if (( status != 0 )); then
    error "upstream skill installation failed (status $status)"
    install_report_untracked
    return "$status"
  fi

  publish_upstream_lock_and_link '' || return 1
  for name in "${INSTALL_SKILLS[@]}"; do
    target="$CANONICAL_DIR/$name"
    info "installed $name: canonical $target; Claude $CLAUDE_SKILLS/$name; Codex $CODEX_SKILLS/$name"
  done
  return 0
}
