# remove subcommand. Uninstall exactly one installed skill through upstream
# `npx skills remove`, verify the name left the upstream lock, publish the
# validated lock, then reconcile links. Nexus never deletes canonical content
# itself; upstream owns `~/.agents/skills`.

parse_remove_args() {
  REMOVE_NAME=''
  if (( $# != 1 )); then
    error "remove requires exactly one skill name"
    return 2
  fi
  if [[ "$1" == -* ]] || ! safe_skill_name "$1"; then
    error "remove requires a safe skill name: $1"
    return 2
  fi
  if is_control_skill "$1"; then
    error "reserved control skill name: $1"
    return 2
  fi
  REMOVE_NAME="$1"
  return 0
}

# Publication guard for the shared upstream flow. A half-done upstream removal
# must never become the Nexus lock.
remove_check() {
  local snapshot="$1" names_array_name="$2" candidate
  local -n remove_check_names="$names_array_name"
  for candidate in "${remove_check_names[@]}"; do
    if [[ "$candidate" == "$REMOVE_NAME" ]]; then
      error "upstream lock still contains $REMOVE_NAME"
      return 1
    fi
  done
  return 0
}

remove_skill() {
  local status=0 name target custom locked found=0
  local -a custom_names=() nexus_lock_names=()
  parse_remove_args "$@" || return $?
  name="$REMOVE_NAME"

  # Every refusal happens before `ensure_npx` and before the upstream call, so
  # a refused removal cannot rewrite the upstream lock or delete content.
  custom_root_preflight || return 1
  collect_custom_names custom_names || return 1
  for custom in "${custom_names[@]}"; do
    if [[ "$name" == "$custom" ]]; then
      error "remove refuses a custom skill: $name; delete $CUSTOM_ROOT/$name yourself and run link"
      return 1
    fi
  done

  load_validated_lock_names "$LOCK_FILE" nexus_lock_names || return 1
  for locked in "${nexus_lock_names[@]}"; do
    if [[ "$locked" == "$name" ]]; then
      found=1
      break
    fi
  done
  if (( found == 0 )); then
    error "skill is not installed: $name"
    return 1
  fi
  ensure_npx || return 1
  env -u XDG_STATE_HOME npx --yes skills remove "$name" --global --yes
  status=$?
  if (( status != 0 )); then
    error "upstream skill removal failed (status $status)"
    return "$status"
  fi

  # Removing the last installed skill leaves a valid, empty lock.
  publish_upstream_lock_and_link remove_check true || return 1

  target="$CANONICAL_DIR/$name"
  if [[ -e "$target" || -L "$target" ]]; then
    info "untracked canonical skill directory: $target"
  fi
  info "removed $name: Claude $CLAUDE_SKILLS/$name and Codex $CODEX_SKILLS/$name links reconciled"
  return 0
}
