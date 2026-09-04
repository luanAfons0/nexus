parse_new_args() {
  NEW_SKILL_NAME=''
  if (( $# != 1 )); then
    error "new requires exactly one skill name"
    return 2
  fi
  if [[ "$1" == -* ]] || ! safe_skill_name "$1"; then
    error "new requires a safe skill name"
    return 2
  fi
  if is_control_skill "$1"; then
    error "reserved control skill name: $1"
    return 2
  fi
  NEW_SKILL_NAME="$1"
  return 0
}

new_skill() {
  local target locked
  local -a lock_names=()
  parse_new_args "$@" || return $?
  custom_root_preflight || return 1
  if [[ ! -d "$CUSTOM_ROOT" ]]; then
    error "custom skill root does not exist: $CUSTOM_ROOT (create it and run git init before adding custom skills)"
    return 1
  fi
  if [[ -f "$LOCK_FILE" ]]; then
    load_validated_lock_names "$LOCK_FILE" lock_names || return 1
    for locked in "${lock_names[@]}"; do
      if [[ "$locked" == "$NEW_SKILL_NAME" ]]; then
        error "name collides with an installed skill: $NEW_SKILL_NAME ($CANONICAL_DIR/$NEW_SKILL_NAME)"
        return 1
      fi
    done
  fi
  target="$CUSTOM_ROOT/$NEW_SKILL_NAME"
  if [[ -e "$target" || -L "$target" ]]; then
    error "custom skill already exists: $target"
    return 1
  fi
  if ! mkdir -- "$target"; then
    error "cannot create custom skill directory: $target"
    return 1
  fi
  info "created $NEW_SKILL_NAME: $target"
  info "workspace $NEW_SKILL_NAME: $CUSTOM_WORKSPACES/$NEW_SKILL_NAME"
  return 0
}
