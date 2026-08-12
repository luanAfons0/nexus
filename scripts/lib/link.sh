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

link_all() {
  local force="${1:-false}" name target
  local -a lock_names=()
  ERRORS=0
  load_validated_lock_names "$LOCK_FILE" lock_names || return 1
  DESIRED_SET=()
  for name in "${lock_names[@]}" "${CONTROL_SKILLS[@]}"; do
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
  if (( ERRORS != 0 )); then
    printf 'nexus: error: link failed with %s error(s)\n' "$ERRORS" >&2
    return 1
  fi
  info "link complete: skills reconciled"
  return 0
}

bootstrap() {
  local name adapter errors_before_summary
  ERRORS=0
  for name in "${CONTROL_SKILLS[@]}"; do
    put_link "$NEXUS_HOME/skills/$name" "$CLAUDE_SKILLS/$name" false || :
    put_link "$NEXUS_HOME/skills/$name" "$CODEX_SKILLS/$name" false || :
    adapter="${name#nexus-}.md"
    put_link "$NEXUS_HOME/skills/$name/claude-command.md" "$HOME/.claude/commands/nexus/$adapter" false || :
  done
  if (( ERRORS != 0 )); then
    errors_before_summary="$ERRORS"
    printf 'nexus: error: bootstrap failed with %s error(s)\n' "$errors_before_summary" >&2
    return 1
  fi
  info "bootstrap complete: control skills and Claude command adapters linked"
  return 0
}


