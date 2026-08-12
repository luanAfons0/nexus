owned_setup_dir() {
  local path="$1" parent="$2" prefix="$3"
  [[ -d "$path" && "$(dirname -- "$path")" == "$parent" &&
     "$(basename -- "$path")" == "$prefix"* ]]
}

cleanup_setup_dir() {
  local path="$1" parent="$2" prefix="$3"
  if ! owned_setup_dir "$path" "$parent" "$prefix"; then
    error "refusing to clean unowned setup path: $path"
    return 1
  fi
  rm -rf -- "$path"
}

cleanup_setup_file() {
  local path="$1" parent="$2" prefix="$3"
  if [[ ! -f "$path" || -L "$path" || "$(dirname -- "$path")" != "$parent" ||
        "$(basename -- "$path")" != "$prefix"* ]]; then
    error "refusing to clean unowned setup file: $path"
    return 1
  fi
  rm -f -- "$path"
}

snapshot_setup_lock() {
  local source="$1" snapshot
  snapshot="$(mktemp -- "$NEXUS_HOME/.nexus-setup-source.XXXXXX")" || {
    error "cannot reserve selected lock snapshot"
    return 1
  }
  if ! cp -- "$source" "$snapshot"; then
    cleanup_setup_file "$snapshot" "$NEXUS_HOME" .nexus-setup-source. || :
    error "cannot snapshot selected lock: $source"
    return 1
  fi
  if ! cmp -s -- "$source" "$snapshot"; then
    cleanup_setup_file "$snapshot" "$NEXUS_HOME" .nexus-setup-source. || :
    error "selected lock snapshot differs from source: $source"
    return 1
  fi
  SETUP_LOCK_SNAPSHOT="$snapshot"
  return 0
}

atomic_copy() {
  local source="$1" destination="$2" allow_existing="${3:-false}" parent temp
  parent="$(dirname -- "$destination")"
  if [[ "$allow_existing" != true && ( -e "$destination" || -L "$destination" ) ]]; then
    error "destination already exists: $destination"
    return 1
  fi
  temp="$(mktemp -- "$parent/.nexus-setup-copy.XXXXXX")" || {
    error "cannot reserve atomic copy destination for $destination"
    return 1
  }
  if ! cp -- "$source" "$temp"; then
    cleanup_setup_file "$temp" "$parent" .nexus-setup-copy. || :
    error "cannot copy source: $source"
    return 1
  fi
  if [[ "$TEST_FAIL" == *lock_copy_corrupt* ]]; then
    printf '%s\n' 'test seam: corrupted staged Nexus lock' >"$temp"
  fi
  if ! cmp -s -- "$source" "$temp"; then
    cleanup_setup_file "$temp" "$parent" .nexus-setup-copy. || :
    error "atomic copy staging verification failed: $destination"
    return 1
  fi
  if ! mv -Tn -- "$temp" "$destination" || [[ -e "$temp" || -L "$temp" ]]; then
    cleanup_setup_file "$temp" "$parent" .nexus-setup-copy. || :
    error "cannot promote copied file: $destination"
    return 1
  fi
  if [[ "$TEST_FAIL" == *lock_post_publish_corrupt* ]]; then
    printf '%s\n' 'test seam: corrupted published Nexus lock' >"$destination"
  fi
  if ! cmp -s -- "$source" "$destination"; then
    error "atomic copy post-publication verification failed: $destination"
    return 1
  fi
  return 0
}

backup_move() {
  local source="$1" destination="$2"
  if [[ "$TEST_FAIL" == *backup_promote_second* && "$destination" == "$HOME/.codex-backup" ]]; then
    error "test seam: second backup promotion failed"
    return 1
  fi
  if [[ "$TEST_FAIL" == *backup_rollback* && "$source" == "$HOME/.claude-backup" ]]; then
    error "test seam: backup rollback failed"
    return 1
  fi
  "$NEXUS_BACKUP_MV" -Tn -- "$source" "$destination" || return 1
  [[ ! -e "$source" && ! -L "$source" ]]
}

canonical_move() {
  local source="$1" destination="$2"
  if [[ "$TEST_FAIL" == *canonical_promote* && "$source" == *'/.nexus-canonical-tmp.'* && "$destination" == "$CANONICAL_CURRENT" ]]; then
    error "test seam: canonical promotion failed"
    return 1
  fi
  if [[ "$TEST_FAIL" == *canonical_restore* && "$destination" == "$CANONICAL_CURRENT" && "$source" == */original ]]; then
    error "test seam: canonical restore failed"
    return 1
  fi
  "$NEXUS_CANONICAL_MV" -Tn -- "$source" "$destination" || return 1
  [[ ! -e "$source" && ! -L "$source" ]]
}

copy_agent_tree() {
  local source="$1" destination="$2"
  mkdir -p -- "$destination" || return 1
  [[ -e "$source" || -L "$source" ]] || return 0
  [[ -d "$source" && ! -L "$source" ]] || {
    error "agent root is not a directory: $source"
    return 1
  }
  "$NEXUS_BACKUP_CP" -a -- "$source/." "$destination/" &&
    chmod --reference="$source" -- "$destination" &&
    chown --reference="$source" -- "$destination" &&
    touch -r "$source" -- "$destination" || return 1
  if [[ "$TEST_FAIL" == *backup_root_corrupt* && "$source" == "$HOME/.claude" ]]; then
    chmod 700 -- "$destination" && touch -d '2026-01-01 00:00:00.987654321' -- "$destination"
  fi
  return 0
}

tree_manifest() {
  local root="$1" manifest="$2" unsorted="$2.unsorted" paths="$2.paths" sorted_paths="$2.sorted-paths" item relative kind metadata hash link_hash link_bytes inode group
  local -A hardlink_groups=()
  : >"$unsorted" || return 1
  [[ -d "$root" && ! -L "$root" ]] || return 1
  emit_manifest_entry() {
    local path="$1" label="$2"
    metadata="$(stat -c '%a|%u|%g|%y' -- "$path")" || return 1
    if [[ -L "$path" ]]; then
      kind='l'
      link_hash="$(readlink -n -- "$path" | sha256sum | awk '{print $1}')" || return 1
      link_bytes="$(readlink -n -- "$path" | wc -c)" || return 1
      printf '%q|%s|%s|%s|%s\0' "$label" "$kind" "$metadata" "$link_bytes" "$link_hash" >>"$unsorted"
    elif [[ -f "$path" ]]; then
      kind='f'
      hash="$(sha256sum -- "$path" | awk '{print $1}')" || return 1
      inode="$(stat -c '%d:%i' -- "$path")" || return 1
      group="${hardlink_groups[$inode]:-$label}"
      hardlink_groups["$inode"]="$group"
      printf '%q|%s|%s|%s|%q\0' "$label" "$kind" "$metadata" "$hash" "$group" >>"$unsorted"
    elif [[ -d "$path" ]]; then
      kind='d'
      printf '%q|%s|%s|-\0' "$label" "$kind" "$metadata" >>"$unsorted"
    else
      error "unsupported agent backup entry: $path"
      return 1
    fi
  }
  emit_manifest_entry "$root" . || return 1
  if ! find -P "$root" -mindepth 1 -print0 >"$paths"; then
    rm -f -- "$paths"
    error "cannot traverse backup tree: $root"
    return 1
  fi
  if ! LC_ALL=C sort -z -- "$paths" >"$sorted_paths"; then
    rm -f -- "$paths" "$sorted_paths"
    error "cannot sort backup tree traversal: $root"
    return 1
  fi
  while IFS= read -r -d '' item; do
    relative="${item#"$root"/}"
    emit_manifest_entry "$item" "$relative" || return 1
  done <"$sorted_paths"
  rm -f -- "$paths" "$sorted_paths"
  LC_ALL=C sort -z -- "$unsorted" >"$manifest" || return 1
  rm -f -- "$unsorted"
  unset -f emit_manifest_entry
  return 0
}

verify_backup_tree() {
  local source="$1" copied="$2" transaction="$3" label="$4"
  local source_manifest="$transaction/$label.source.manifest" copied_manifest="$transaction/$label.copied.manifest"
  if [[ ! -e "$source" && ! -L "$source" ]]; then
    [[ -d "$copied" && ! -L "$copied" && -z "$(find -P "$copied" -mindepth 1 -print -quit)" ]] || {
      error "backup verification failed for absent source $source"
      return 1
    }
    return 0
  fi
  if ! tree_manifest "$source" "$source_manifest" || ! tree_manifest "$copied" "$copied_manifest" ||
       ! cmp -s -- "$source_manifest" "$copied_manifest"; then
    error "backup verification failed for $source"
    return 1
  fi
  return 0
}

cleanup_backup_manifests() {
  local transaction="$1" label
  for label in claude codex claude-final codex-final; do
    rm -f -- "$transaction/$label.source.manifest" "$transaction/$label.copied.manifest" \
      "$transaction/$label.source.manifest.unsorted" "$transaction/$label.copied.manifest.unsorted" || return 1
    rm -f -- "$transaction/$label.source.manifest.paths" "$transaction/$label.copied.manifest.paths" \
      "$transaction/$label.source.manifest.sorted-paths" "$transaction/$label.copied.manifest.sorted-paths" || return 1
  done
  return 0
}

backup_transaction() {
  local claude_backup="$HOME/.claude-backup" codex_backup="$HOME/.codex-backup"
  local tx='' claude_tmp codex_tmp
  [[ ! -e "$claude_backup" && ! -L "$claude_backup" ]] || {
    error "backup already exists: $claude_backup"
    return 1
  }
  [[ ! -e "$codex_backup" && ! -L "$codex_backup" ]] || {
    error "backup already exists: $codex_backup"
    return 1
  }
  tx="$(mktemp -d -- "$HOME/.nexus-setup-backup.XXXXXX")" || {
    error "cannot reserve setup backup transaction"
    return 1
  }
  owned_setup_dir "$tx" "$HOME" .nexus-setup-backup. || {
    error "invalid setup backup transaction: $tx"
    return 1
  }
  claude_tmp="$tx/claude-backup"
  codex_tmp="$tx/codex-backup"
  if ! copy_agent_tree "$HOME/.claude" "$claude_tmp" ||
       ! verify_backup_tree "$HOME/.claude" "$claude_tmp" "$tx" claude ||
       ! copy_agent_tree "$HOME/.codex" "$codex_tmp" ||
       ! verify_backup_tree "$HOME/.codex" "$codex_tmp" "$tx" codex; then
    error "cannot create complete agent backups"
    cleanup_setup_dir "$tx" "$HOME" .nexus-setup-backup. || :
    return 1
  fi
  if ! backup_move "$claude_tmp" "$claude_backup"; then
    error "cannot promote Claude backup"
    cleanup_setup_dir "$tx" "$HOME" .nexus-setup-backup. || :
    return 1
  fi
  if ! backup_move "$codex_tmp" "$codex_backup"; then
    error "cannot promote Codex backup"
    if ! backup_move "$claude_backup" "$claude_tmp"; then
      error "backup recovery retained: $claude_backup; $tx (Codex backup: $codex_tmp)"
      return 1
    fi
    cleanup_setup_dir "$tx" "$HOME" .nexus-setup-backup. || :
    return 1
  fi
  if ! verify_backup_tree "$HOME/.claude" "$claude_backup" "$tx" claude-final ||
       ! verify_backup_tree "$HOME/.codex" "$codex_backup" "$tx" codex-final; then
    cleanup_backup_manifests "$tx" || error "backup verification transaction retained: $tx"
    rmdir -- "$tx" || error "backup verification transaction retained: $tx"
    error "final backup verification failed; backups retained at: $claude_backup and $codex_backup"
    return 1
  fi
  if ! cleanup_backup_manifests "$tx"; then
    error "backup verification transaction retained: $tx"
    return 1
  fi
  rmdir -- "$tx" || {
    error "setup backup transaction retained: $tx"
    return 1
  }
  SETUP_CLAUDE_BACKUP="$claude_backup"
  SETUP_CODEX_BACKUP="$codex_backup"
  return 0
}

setup_backup_preflight() {
  local claude_backup="$HOME/.claude-backup" codex_backup="$HOME/.codex-backup" failed=0
  command_requirements || failed=1
  if [[ -e "$claude_backup" || -L "$claude_backup" ]]; then
    error "backup already exists: $claude_backup"
    failed=1
  fi
  if [[ -e "$codex_backup" || -L "$codex_backup" ]]; then
    error "backup already exists: $codex_backup"
    failed=1
  fi
  (( failed == 0 ))
}

publish_setup_lock() {
  local source="$1"
  [[ ! -e "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || {
    error "Nexus lock already exists: $LOCK_FILE"
    return 1
  }
  mkdir -p -- "$NEXUS_HOME" || { error "cannot create Nexus home: $NEXUS_HOME"; return 1; }
  if ! atomic_copy "$source" "$LOCK_FILE" false; then
    error "cannot publish Nexus lock"
    return 1
  fi
  return 0
}

valid_physical_skill() {
  [[ -d "$1" && ! -L "$1" && -f "$1/SKILL.md" ]]
}

canonical_root_preflight() {
  [[ -d "$HOME/.agents" && ! -L "$HOME/.agents" ]] || {
    error "canonical agent root must be a physical directory: $HOME/.agents"
    return 1
  }
  if [[ -e "$CANONICAL_DIR" || -L "$CANONICAL_DIR" ]]; then
    [[ -d "$CANONICAL_DIR" && ! -L "$CANONICAL_DIR" ]] || {
      error "canonical skills root must be a physical directory: $CANONICAL_DIR"
      return 1
    }
  fi
  return 0
}

validate_canonical_skill() {
  local skill="$1" skill_real file link resolved
  [[ -d "$skill" && ! -L "$skill" && -f "$skill/SKILL.md" && ! -L "$skill/SKILL.md" ]] || {
    error "canonical skill must contain a physical SKILL.md: $skill"
    return 1
  }
  skill_real="$(realpath -e -- "$skill")" || return 1
  file="$(realpath -e -- "$skill/SKILL.md")" || return 1
  path_is_within "$skill_real" "$(realpath -e -- "$CANONICAL_DIR")" && path_is_within "$file" "$skill_real" || {
    error "canonical skill escapes its physical tree: $skill"
    return 1
  }
  while IFS= read -r -d '' link; do
    resolved="$(realpath -e -- "$link")" || {
      error "canonical skill has broken or cyclic symlink: $link"
      return 1
    }
    path_is_within "$resolved" "$skill_real" || {
      error "canonical skill symlink escapes skill tree: $link"
      return 1
    }
  done < <(find -P "$skill" -type l -print0)
  return 0
}

cleanup_canonical_temp() {
  local temp="$1"
  if [[ "$TEST_FAIL" == *canonical_cleanup* ]]; then
    error "test seam: canonical temp cleanup failed"
    return 1
  fi
  cleanup_setup_dir "$temp" "$CANONICAL_DIR" .nexus-canonical-tmp.
}

materialize_canonical_link() {
  local name="$1" current="$CANONICAL_DIR/$name" target='' temp='' recovery='' original
  CANONICAL_CURRENT="$current"
  [[ -L "$current" ]] || return 0
  target="$(realpath -- "$current")" || {
    error "managed canonical skill is a broken symlink: $current; correct it, then run nexus link"
    return 1
  }
  [[ -d "$target" && -f "$target/SKILL.md" ]] || {
    error "managed canonical skill target lacks SKILL.md: $current; correct it, then run nexus link"
    return 1
  }
  mkdir -p -- "$CANONICAL_DIR" || { error "cannot create canonical directory: $CANONICAL_DIR"; return 1; }
  temp="$(mktemp -d -- "$CANONICAL_DIR/.nexus-canonical-tmp.XXXXXX")" || {
    error "cannot reserve canonical materialization temp for $current"
    return 1
  }
  if ! "$NEXUS_CANONICAL_CP" -aL -- "$target/." "$temp/" || ! valid_physical_skill "$temp"; then
    cleanup_canonical_temp "$temp" || error "canonical temp retained: $temp"
    error "cannot materialize canonical skill: $current"
    return 1
  fi
  recovery="$(mktemp -d -- "$CANONICAL_DIR/.nexus-canonical-old.XXXXXX")" || {
    cleanup_canonical_temp "$temp" || error "canonical temp retained: $temp"
    error "cannot reserve canonical recovery for $current"
    return 1
  }
  original="$recovery/original"
  if ! canonical_move "$current" "$original"; then
    cleanup_canonical_temp "$temp" || error "canonical temp retained: $temp"
    rmdir -- "$recovery" || error "canonical recovery retained: $recovery"
    error "cannot stage canonical symlink: $current"
    return 1
  fi
  if ! canonical_move "$temp" "$current" || ! valid_physical_skill "$current"; then
    if [[ -d "$current" && ! -L "$current" && -d "$temp" ]] &&
       [[ "$(stat -c '%d:%i' -- "$current")" == "$(stat -c '%d:%i' -- "$temp")" ]]; then
      cleanup_canonical_temp "$current" || error "canonical staged current retained: $current"
    elif [[ -e "$current" || -L "$current" ]]; then
      error "canonical promotion is ambiguous; retained current: $current; staged temp: $temp; recovery: $recovery"
      return 1
    fi
    if [[ -d "$temp" ]] && ! cleanup_canonical_temp "$temp"; then
      error "canonical temp retained: $temp"
    fi
    if ! canonical_move "$original" "$current"; then
      error "canonical recovery retained: $recovery"
      return 1
    fi
    rmdir -- "$recovery" || error "canonical recovery retained: $recovery"
    error "cannot promote canonical skill: $current"
    return 1
  fi
  rm -- "$original" || { error "canonical recovery retained: $recovery"; return 1; }
  rmdir -- "$recovery" || { error "canonical recovery retained: $recovery"; return 1; }
  return 0
}

materialize_canonical_links() {
  local name
  for name in "${SETUP_LOCK_NAMES[@]}"; do
    materialize_canonical_link "$name" || return 1
    [[ -e "$CANONICAL_DIR/$name" || -L "$CANONICAL_DIR/$name" ]] || continue
    validate_canonical_skill "$CANONICAL_DIR/$name" || return 1
  done
  return 0
}

setup_lock_acquire() {
  SETUP_MUTEX="$NEXUS_HOME/.nexus-setup.lock"
  if ! mkdir -- "$SETUP_MUTEX"; then
    error "another setup is already running or recovery is required: $SETUP_MUTEX"
    return 1
  fi
  [[ -d "$SETUP_MUTEX" && ! -L "$SETUP_MUTEX" && "$(dirname -- "$SETUP_MUTEX")" == "$NEXUS_HOME" ]] || {
    error "invalid setup lock directory: $SETUP_MUTEX"
    return 1
  }
  return 0
}

setup_lock_release() {
  [[ -n "${SETUP_MUTEX:-}" && -d "$SETUP_MUTEX" && ! -L "$SETUP_MUTEX" &&
     "$(dirname -- "$SETUP_MUTEX")" == "$NEXUS_HOME" ]] || return 0
  rmdir -- "$SETUP_MUTEX" || {
    error "setup lock retained for recovery: $SETUP_MUTEX"
    return 1
  }
  SETUP_MUTEX=''
  return 0
}

post_publication_failure() {
  local detail="$1"
  error "$detail"
  error "setup is now initialized/disabled; retained Nexus lock: $LOCK_FILE; retained backups: $SETUP_CLAUDE_BACKUP and $SETUP_CODEX_BACKUP"
  error "correct the reported issue, then run /nexus:link or \$nexus-link (CLI: $NEXUS_HOME/scripts/nexus link)"
}

setup_inner() {
  local selected third_party_count linked_entries
  ERRORS=0
  if [[ -e "$LOCK_FILE" || -L "$LOCK_FILE" ]]; then
    info "already initialized; run /nexus:link or \$nexus-link to reconcile skills"
    return 0
  fi
  setup_backup_preflight || return 1
  discover_lock || return 1
  canonical_root_preflight || return 1
  selected="$DISCOVERED_LOCK"
  SETUP_LOCK_SNAPSHOT="$DISCOVERED_LOCK_SNAPSHOT"
  load_validated_lock_names "$SETUP_LOCK_SNAPSHOT" SETUP_LOCK_NAMES || return 1
  if ! backup_transaction; then
    return 1
  fi
  if ! publish_setup_lock "$SETUP_LOCK_SNAPSHOT"; then
    if [[ -e "$LOCK_FILE" || -L "$LOCK_FILE" ]]; then
      post_publication_failure "Nexus lock publication verification failed"
    else
      error "backups retained at: $SETUP_CLAUDE_BACKUP and $SETUP_CODEX_BACKUP"
    fi
    return 1
  fi
  if ! materialize_canonical_links || ! link_all true || ! materialize_canonical_links; then
    post_publication_failure "setup encountered a post-publication failure"
    return 1
  fi
  third_party_count="${#SETUP_LOCK_NAMES[@]}"
  linked_entries="$(( (third_party_count + ${#CONTROL_SKILLS[@]}) * 2 ))"
  info "setup complete: source lock: $selected; Claude backup: $SETUP_CLAUDE_BACKUP; Codex backup: $SETUP_CODEX_BACKUP; third-party skills: $third_party_count; linked agent skill entries: $linked_entries (two agents; includes ${#CONTROL_SKILLS[@]} controls)"
  return 0
}

setup() {
  local status=0
  if [[ -e "$LOCK_FILE" || -L "$LOCK_FILE" ]]; then
    info "already initialized; run /nexus:link or \$nexus-link to reconcile skills"
    return 0
  fi
  setup_lock_acquire || return 1
  setup_inner || status=$?
  cleanup_discovered_lock_snapshots || status=1
  setup_lock_release || status=1
  return "$status"
}


