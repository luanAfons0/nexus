# update subcommand. Refresh exactly one installed skill through upstream
# `npx skills update`, then publish the validated lock and reconcile links.

parse_update_args() {
  UPDATE_SKILL_NAME=''
  if (( $# != 1 )); then
    error "update requires exactly one skill name"
    return 2
  fi
  if [[ "$1" == -* ]] || ! safe_skill_name "$1"; then
    error "update requires a safe skill name"
    return 2
  fi
  if is_control_skill "$1"; then
    error "reserved control skill name: $1"
    return 2
  fi
  UPDATE_SKILL_NAME="$1"
  return 0
}

# Report the recorded folder hash, or `unknown` when the lock omits it.
update_lock_hash() {
  local file="$1" name="$2" hash=''
  hash="$(jq -r --arg name "$name" '.skills[$name].skillFolderHash // "unknown"' "$file" 2>/dev/null)" || hash=''
  [[ -n "$hash" ]] || hash='unknown'
  printf '%s\n' "$hash"
}

# Publication check: upstream must still track the updated skill.
update_check() {
  local names_array_name="$2" name
  local -n names="$names_array_name"
  for name in "${names[@]}"; do
    [[ "$name" == "$UPDATE_SKILL_NAME" ]] && return 0
  done
  error "upstream lock no longer contains $UPDATE_SKILL_NAME"
  return 1
}

update_skill() {
  local status=0 old_hash new_hash locked custom found=0
  local -a nexus_lock_names=() custom_names=()
  parse_update_args "$@" || return $?
  # Every refusal happens before the network call, so a name Nexus cannot
  # own never reaches upstream and no upstream lock is rewritten.
  custom_root_preflight || return 1
  collect_custom_names custom_names || return 1
  for custom in "${custom_names[@]}"; do
    if [[ "$custom" == "$UPDATE_SKILL_NAME" ]]; then
      error "update refuses a custom skill: $UPDATE_SKILL_NAME ($CUSTOM_ROOT/$UPDATE_SKILL_NAME); pull it in the custom root and run link"
      return 1
    fi
  done
  load_validated_lock_names "$LOCK_FILE" nexus_lock_names || return 1
  for locked in "${nexus_lock_names[@]}"; do
    if [[ "$locked" == "$UPDATE_SKILL_NAME" ]]; then
      found=1
      break
    fi
  done
  if (( found == 0 )); then
    error "skill is not installed: $UPDATE_SKILL_NAME"
    return 1
  fi
  old_hash="$(update_lock_hash "$LOCK_FILE" "$UPDATE_SKILL_NAME")"

  ensure_npx || return 1
  env -u XDG_STATE_HOME npx --yes skills update "$UPDATE_SKILL_NAME" --global --yes
  status=$?
  if (( status != 0 )); then
    error "upstream skill update failed (status $status)"
    return "$status"
  fi

  publish_upstream_lock_and_link update_check || return 1
  new_hash="$(update_lock_hash "$LOCK_FILE" "$UPDATE_SKILL_NAME")"
  info "updated $UPDATE_SKILL_NAME: hash $old_hash -> $new_hash; canonical $CANONICAL_DIR/$UPDATE_SKILL_NAME; Claude $CLAUDE_SKILLS/$UPDATE_SKILL_NAME; Codex $CODEX_SKILLS/$UPDATE_SKILL_NAME"
  return 0
}
