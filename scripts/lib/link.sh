build_desired_names() {
  local name smallest
  local -A remaining=()
  local LC_ALL=C
  DESIRED_NAMES=()
  for name in "${!DESIRED_SET[@]}"; do
    remaining["$name"]=1
  done
  while (( ${#remaining[@]} != 0 )); do
    smallest=''
    for name in "${!remaining[@]}"; do
      if [[ -z "$smallest" || "$name" < "$smallest" ]]; then
        smallest="$name"
      fi
    done
    DESIRED_NAMES+=("$smallest")
    unset 'remaining[$smallest]'
  done
}
desired_names() {
  printf '%s\n' "${DESIRED_NAMES[@]}"
}

remove_stale_links() {
  local dir="$1" child name dotglob_setting nullglob_setting failed=0
  [[ -d "$dir" ]] || return 0
  dotglob_setting="$(shopt -p dotglob)"
  nullglob_setting="$(shopt -p nullglob)"
  shopt -s dotglob nullglob
  for child in "$dir"/*; do
    name="$(basename -- "$child")"
    [[ "$name" == .system || ! -L "$child" ]] && continue
    desired_contains "$name" && continue
    if is_managed_link "$child"; then
      if rm -- "$child"; then
        info "removed stale managed link: $child"
      else
        error "cannot remove stale managed link: $child"
        failed=1
      fi
    fi
  done
  eval "$dotglob_setting"
  eval "$nullglob_setting"
  return "$failed"
}

remove_missing_managed_link() {
  local link="$1"
  [[ -L "$link" ]] || return 0
  is_managed_link "$link" || return 0
  if rm -- "$link"; then
    info "removed missing managed link: $link"
    return 0
  fi
  error "cannot remove missing managed link: $link"
  return 1
}

# The Global Instructions are owned by GLOBAL.md at the top of the Custom
# Root. Each Instruction Path becomes a relative Managed Link to that file.
# A Foreign Entry at an Instruction Path is preserved and only that link is
# skipped; it is deliberately not a collision (ADR 0003). Nexus never creates
# an Agent Home, so an absent one skips its Instruction Path.
global_instructions_present() {
  [[ -f "$GLOBAL_INSTRUCTIONS" && ! -L "$GLOBAL_INSTRUCTIONS" ]]
}

link_instruction_path() {
  local path="$1" home
  home="$(dirname -- "$path")"
  [[ -d "$home" ]] || return 0
  if [[ -L "$path" ]]; then
    is_managed_link "$path" || return 0
  elif [[ -e "$path" ]]; then
    return 0
  fi
  put_link "$GLOBAL_INSTRUCTIONS" "$path" false
}

link_instruction_paths() {
  global_instructions_present || return 0
  link_instruction_path "$CLAUDE_INSTRUCTIONS" || :
  link_instruction_path "$CODEX_INSTRUCTIONS" || :
  return 0
}

link_all() {
  local force="${1:-false}" name target preflight_failed=0
  local -a lock_names=() custom_names=()
  ERRORS=0
  load_validated_lock_names "$LOCK_FILE" lock_names || return 1

  # Preflight. A malformed custom root or an ambiguous desired set is a
  # configuration fault, not a per-link failure, so nothing is mutated until
  # every check passes.
  custom_root_preflight || preflight_failed=1
  collect_custom_names custom_names || preflight_failed=1
  custom_canonical_preflight || preflight_failed=1
  custom_collision_preflight lock_names custom_names || preflight_failed=1
  if (( preflight_failed != 0 || ERRORS != 0 )); then
    printf 'nexus: error: link failed with %s error(s); no changes were made\n' "$ERRORS" >&2
    return 1
  fi

  CUSTOM_SET=()
  for name in "${custom_names[@]}"; do
    CUSTOM_SET["$name"]=1
  done
  DESIRED_SET=()
  for name in "${lock_names[@]}" "${custom_names[@]}" "${CONTROL_SKILLS[@]}"; do
    if ! safe_skill_name "$name"; then
      error "invalid version-3 lock: unsafe desired skill name"
      return 1
    fi
    DESIRED_SET["$name"]=1
  done
  build_desired_names

  remove_stale_links "$CLAUDE_SKILLS" || :
  remove_stale_links "$CODEX_SKILLS" || :
  for name in "${DESIRED_NAMES[@]}"; do
    target="$(skill_target "$name")"
    if [[ ! -f "$target/SKILL.md" ]]; then
      error "missing skill: $name (expected $target/SKILL.md)"
      remove_missing_managed_link "$CLAUDE_SKILLS/$name" || :
      remove_missing_managed_link "$CODEX_SKILLS/$name" || :
      continue
    fi
    put_link "$target" "$CLAUDE_SKILLS/$name" "$force" || :
    put_link "$target" "$CODEX_SKILLS/$name" "$force" || :
  done
  link_instruction_paths
  if (( ERRORS != 0 )); then
    printf 'nexus: error: link failed with %s error(s)\n' "$ERRORS" >&2
    return 1
  fi
  info "link complete: skills reconciled"
  return 0
}

bootstrap() {
  local name errors_before_summary
  ERRORS=0
  for name in "${CONTROL_SKILLS[@]}"; do
    put_link "$NEXUS_HOME/skills/$name" "$CLAUDE_SKILLS/$name" false || :
    put_link "$NEXUS_HOME/skills/$name" "$CODEX_SKILLS/$name" false || :
  done
  if (( ERRORS != 0 )); then
    errors_before_summary="$ERRORS"
    printf 'nexus: error: bootstrap failed with %s error(s)\n' "$errors_before_summary" >&2
    return 1
  fi
  info "bootstrap complete: control skills linked"
  return 0
}
