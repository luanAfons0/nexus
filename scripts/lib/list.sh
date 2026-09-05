help_text() {
  cat <<'EOF'
Usage: nexus <bootstrap|setup|link|install|update|remove|new|list|global|help>

bootstrap    Link only the Nexus control skills.
setup        Run one-time initialization with backups.
link         Reconcile Claude and Codex links from the lock.
install      Install selected skills from one source via upstream npx skills.
update       Update one installed skill and relink.
remove       Uninstall one installed skill and relink.
new          Reserve a custom skill directory.
list         Show installed, custom, and control skills.
global       Show or replace the Global Instructions: global show [--json], global edit [--if-match <sha256>].
help         Show this text.
EOF
}

list_lock_field() {
  local name="$1" field="$2" value
  value="$(jq -r --arg n "$name" --arg f "$field" '.skills[$n][$f] // empty' "$LOCK_FILE" 2>/dev/null)"
  [[ -n "$value" ]] && printf '%s\n' "$value" || printf '%s\n' '-'
}

# State of one Instruction Path, read-only: linked (a Managed Link resolving
# to the Owner file), foreign (anything else present), absent (nothing at the
# path, Agent Home present), or "no home" (Agent Home directory absent).
instruction_path_state() {
  local path="$1" home
  home="$(dirname -- "$path")"
  if [[ ! -d "$home" ]]; then
    printf 'no home\n'
  elif [[ ! -e "$path" && ! -L "$path" ]]; then
    printf 'absent\n'
  elif links_exactly_to "$path" "$GLOBAL_INSTRUCTIONS"; then
    printf 'linked\n'
  else
    printf 'foreign\n'
  fi
}

global_instructions_line() {
  local owner claude codex
  if global_instructions_present; then
    owner="$GLOBAL_INSTRUCTIONS"
  else
    owner="absent ($GLOBAL_INSTRUCTIONS)"
  fi
  claude="$(instruction_path_state "$CLAUDE_INSTRUCTIONS")"
  codex="$(instruction_path_state "$CODEX_INSTRUCTIONS")"
  printf 'global instructions: %s (claude: %s, codex: %s)\n' "$owner" "$claude" "$codex"
}

list_skills() {
  local -a lock_names=() custom_names=()
  local name source hash updated
  local -a rows=()

  if [[ -f "$LOCK_FILE" ]]; then
    load_validated_lock_names "$LOCK_FILE" lock_names || return 1
  else
    info "lock is absent: $LOCK_FILE"
  fi

  custom_root_preflight || return 1
  global_instructions_preflight || return 1
  collect_custom_names custom_names || return 1

  for name in "${lock_names[@]}"; do
    source="$(list_lock_field "$name" source)"
    hash="$(list_lock_field "$name" skillFolderHash)"
    [[ "$hash" == '-' ]] || hash="${hash:0:8}"
    updated="$(list_lock_field "$name" updatedAt)"
    rows+=("$name"$'\t'"installed"$'\t'"$source"$'\t'"$hash"$'\t'"$updated")
  done

  for name in "${custom_names[@]}"; do
    rows+=("$name"$'\t'"custom"$'\t'-$'\t'-$'\t'-)
  done

  for name in "${CONTROL_SKILLS[@]}"; do
    rows+=("$name"$'\t'"control"$'\t'-$'\t'-$'\t'-)
  done

  printf 'name\tkind\tsource\thash\tupdated\n'
  if (( ${#rows[@]} != 0 )); then
    printf '%s\n' "${rows[@]}" | LC_ALL=C sort -t "$(printf '\t')" -k1,1
  fi
  global_instructions_line
  return 0
}
