custom_root_preflight() {
  [[ -e "$CUSTOM_ROOT" || -L "$CUSTOM_ROOT" ]] || return 0
  if [[ -L "$CUSTOM_ROOT" || ! -d "$CUSTOM_ROOT" ]]; then
    error "custom skill root must be a physical directory: $CUSTOM_ROOT"
    return 1
  fi
  return 0
}

collect_custom_names() {
  local output_array_name="$1" child name failed=0 nullglob_setting
  local -n output_array="$output_array_name"
  output_array=()
  [[ -d "$CUSTOM_ROOT" && ! -L "$CUSTOM_ROOT" ]] || return 0
  nullglob_setting="$(shopt -p nullglob)"
  # Deliberately without dotglob: dotted entries such as .git and .workspaces
  # are repository furniture, never skills.
  shopt -s nullglob
  for child in "$CUSTOM_ROOT"/*; do
    name="$(basename -- "$child")"
    if [[ -L "$child" ]]; then
      error "custom skill entry must not be a symlink: $child"
      failed=1
      continue
    fi
    # Top-level regular files are repository furniture: README, LICENSE, ...
    [[ -f "$child" ]] && continue
    if [[ ! -d "$child" ]]; then
      error "unexpected entry in custom skill root: $child"
      failed=1
      continue
    fi
    if ! safe_skill_name "$name"; then
      error "unsafe custom skill name: $child"
      failed=1
      continue
    fi
    if is_control_skill "$name"; then
      error "reserved control skill name in custom skill root: $child"
      failed=1
      continue
    fi
    if [[ -L "$child/SKILL.md" || ! -f "$child/SKILL.md" ]]; then
      error "custom skill is missing SKILL.md: $child/SKILL.md"
      failed=1
      continue
    fi
    output_array+=("$name")
  done
  eval "$nullglob_setting"
  return "$failed"
}

custom_canonical_preflight() {
  local child resolved custom_resolved failed=0 dotglob_setting nullglob_setting
  [[ -d "$CANONICAL_DIR" ]] || return 0
  custom_resolved="$(realpath -m -- "$CUSTOM_ROOT")"
  dotglob_setting="$(shopt -p dotglob)"
  nullglob_setting="$(shopt -p nullglob)"
  shopt -s dotglob nullglob
  for child in "$CANONICAL_DIR"/*; do
    [[ -L "$child" ]] || continue
    resolved="$(resolved_link_target "$child")" || continue
    if path_is_within "$resolved" "$custom_resolved"; then
      error "custom skill link in canonical root: $child -> $resolved (remove it; custom skills are owned by $CUSTOM_ROOT)"
      failed=1
    fi
  done
  eval "$dotglob_setting"
  eval "$nullglob_setting"
  return "$failed"
}

custom_collision_preflight() {
  local lock_array_name="$1" custom_array_name="$2" locked custom failed=0
  local -n lock_array="$lock_array_name"
  local -n custom_array="$custom_array_name"
  for custom in "${custom_array[@]}"; do
    for locked in "${lock_array[@]}"; do
      if [[ "$custom" == "$locked" ]]; then
        error "custom skill collides with an installed skill: $custom ($CUSTOM_ROOT/$custom and $CANONICAL_DIR/$custom)"
        failed=1
      fi
    done
  done
  return "$failed"
}
