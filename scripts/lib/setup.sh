BACKUP_MANIFEST_HELPER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/backup_manifest.py"

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
  setup_register_temp "$snapshot"
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
  if ! cmp -s -- "$source" "$destination"; then
    error "atomic copy post-publication verification failed: $destination"
    return 1
  fi
  return 0
}

backup_move() {
  local source="$1" destination="$2"
  mv -Tn -- "$source" "$destination" || return 1
  [[ ! -e "$source" && ! -L "$source" ]]
}

canonical_move() {
  local source="$1" destination="$2"
  mv -Tn -- "$source" "$destination" || return 1
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
  cp -a -- "$source/." "$destination/" &&
    chmod --reference="$source" -- "$destination" &&
    chown --reference="$source" -- "$destination" &&
    touch -r "$source" -- "$destination" || return 1
  return 0
}

backup_manifest() {
  local root="$1" full="$2" state="$3"
  python3 "$BACKUP_MANIFEST_HELPER" "$root" "$full" "$state"
}

verify_backup_attempt() {
  local source="$1" copied="$2" tx="$3" label="$4"
  local sf="$tx/$label.source.full" ss="$tx/$label.source.state"
  local cf="$tx/$label.copied.full" cs="$tx/$label.copied.state"
  local sa="$tx/$label.source.after.state" compare_result
  backup_manifest "$source" "$sf" "$ss" || return 1
  copy_agent_tree "$source" "$copied" || return 1
  backup_manifest "$copied" "$cf" "$cs" || return 1
  if [[ ! -e "$source" && ! -L "$source" ]]; then
    [[ -d "$copied" && ! -L "$copied" && -z "$(find -P "$copied" -mindepth 1 -print -quit)" ]] || return 2
  elif cmp -s -- "$sf" "$cf"; then
    :
  else
    compare_result=$?
    if (( compare_result != 1 )); then
      error "cannot compare backup manifests for $source"
      return 1
    fi
    error "backup verification failed for $source"
    return 2
  fi
  if [[ ! -e "$source" && ! -L "$source" ]]; then
    :
  elif cmp -s -- "$ss" "$cs"; then
    :
  else
    compare_result=$?
    if (( compare_result != 1 )); then
      error "cannot compare copied state manifests for $source"
      return 1
    fi
    error "backup verification failed for $source"
    return 2
  fi
  backup_manifest "$source" "$sa.full" "$sa" || return 1
  if cmp -s -- "$ss" "$sa"; then
    :
  else
    compare_result=$?
    if (( compare_result != 1 )); then
      error "cannot compare source state manifests for $source"
      return 1
    fi
    error "backup verification failed for $source"
    return 2
  fi
  rm -f -- "$sa.tmp"
  return 0
}

cleanup_backup_manifests() {
  local transaction="$1"
  rm -f -- "$transaction"/*.full "$transaction"/*.state "$transaction"/*.tmp 2>/dev/null || return 1
}

backup_transaction() {
  local claude_backup="$HOME/.claude-backup" codex_backup="$HOME/.codex-backup"
  local tx='' claude_tmp codex_tmp attempt result claude_inode codex_inode
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
  setup_register_temp "$tx"
  SETUP_PHASE='backup_staging'
  for attempt in 1 2; do
    export BACKUP_ATTEMPT="$attempt"
    claude_tmp="$tx/claude-backup"
    codex_tmp="$tx/codex-backup"
    [[ "$attempt" == 1 ]] || { rm -rf -- "$claude_tmp" "$codex_tmp"; }
    verify_backup_attempt "$HOME/.claude" "$claude_tmp" "$tx" claude; result=$?
    if (( result == 0 )); then
      verify_backup_attempt "$HOME/.codex" "$codex_tmp" "$tx" codex; result=$?
    fi
    (( result == 0 )) && break
    if (( result == 1 )); then
      error "cannot create complete agent backups"
      cleanup_setup_dir "$tx" "$HOME" .nexus-setup-backup. || :
      return 1
    fi
    [[ "$attempt" == 1 ]] || {
      error "agent state changed during backup; close Claude and Codex and retry"
      cleanup_setup_dir "$tx" "$HOME" .nexus-setup-backup. || :
      return 1
    }
  done
  unset BACKUP_ATTEMPT
  claude_inode="$(stat -c '%d:%i:%F' -- "$claude_tmp")" || return 1
  codex_inode="$(stat -c '%d:%i:%F' -- "$codex_tmp")" || return 1
  if ! backup_move "$claude_tmp" "$claude_backup"; then
    error "cannot promote Claude backup"
    cleanup_setup_dir "$tx" "$HOME" .nexus-setup-backup. || :
    return 1
  fi
  SETUP_PHASE='backup_promoting'
  if ! backup_move "$codex_tmp" "$codex_backup"; then
    error "cannot promote Codex backup"
    if ! backup_move "$claude_backup" "$claude_tmp"; then
      error "backup recovery retained: $claude_backup; $tx (Codex backup: $codex_tmp)"
      return 1
    fi
    cleanup_setup_dir "$tx" "$HOME" .nexus-setup-backup. || :
    return 1
  fi
  [[ ! -e "$claude_tmp" && ! -L "$claude_tmp" ]] || { error "Claude backup promotion did not consume verified tree"; return 1; }
  [[ ! -e "$codex_tmp" && ! -L "$codex_tmp" ]] || { error "Codex backup promotion did not consume verified tree"; return 1; }
  [[ "$(stat -c '%d:%i:%F' -- "$claude_backup")" == "$claude_inode" && "$(stat -c '%d:%i:%F' -- "$codex_backup")" == "$codex_inode" ]] || {
    error "backup promotion changed verified tree identity"
    return 1
  }
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
  setup_unregister_path "$tx"
  SETUP_PHASE='backups_complete'
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
  [[ -d "$target" && ! -L "$target" && -f "$target/SKILL.md" && ! -L "$target/SKILL.md" ]] || {
    error "managed canonical skill target lacks SKILL.md: $current; correct it, then run nexus link"
    return 1
  }
  if ! python3 "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/validate_skill_tree.py" "$target"; then
    error "cannot materialize canonical skill safely: nested source symlink is broken, cyclic, or escapes $target"
    return 1
  fi
  mkdir -p -- "$CANONICAL_DIR" || { error "cannot create canonical directory: $CANONICAL_DIR"; return 1; }
  temp="$(mktemp -d -- "$CANONICAL_DIR/.nexus-canonical-tmp.XXXXXX")" || {
    error "cannot reserve canonical materialization temp for $current"
    return 1
  }
  setup_register_temp "$temp"
  if ! cp -aL -- "$target/." "$temp/" || ! valid_physical_skill "$temp"; then
    cleanup_canonical_temp "$temp" || error "canonical temp retained: $temp"
    error "cannot materialize canonical skill: $current"
    return 1
  fi
  recovery="$(mktemp -d -- "$CANONICAL_DIR/.nexus-canonical-old.XXXXXX")" || {
    cleanup_canonical_temp "$temp" || error "canonical temp retained: $temp"
    error "cannot reserve canonical recovery for $current"
    return 1
  }
  setup_register_recovery "$recovery"
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
  setup_unregister_path "$temp"
  setup_unregister_path "$recovery"
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
  setup_install_traps
  return 0
}

setup_register_temp() {
  local path="$1"
  [[ -n "$path" ]] || return 0
  SETUP_OWNED_TEMPS+=("$path")
}

setup_register_recovery() {
  local path="$1"
  [[ -n "$path" ]] || return 0
  SETUP_OWNED_RECOVERY+=("$path")
}

setup_unregister_path() {
  local path="$1" item
  local -a keep=()
  for item in "${SETUP_OWNED_TEMPS[@]}"; do [[ "$item" == "$path" ]] || keep+=("$item"); done
  SETUP_OWNED_TEMPS=("${keep[@]}"); keep=()
  for item in "${SETUP_OWNED_RECOVERY[@]}"; do [[ "$item" == "$path" ]] || keep+=("$item"); done
  SETUP_OWNED_RECOVERY=("${keep[@]}")
}

setup_cleanup_owned_paths() {
  local path
  for path in "${SETUP_OWNED_TEMPS[@]}" "${SETUP_OWNED_RECOVERY[@]}"; do
    [[ -n "$path" ]] || continue
    case "$path" in
      "$HOME"/.nexus-setup-backup.*|"$CANONICAL_DIR"/.nexus-canonical-tmp.*|"$CANONICAL_DIR"/.nexus-canonical-old.*|"$NEXUS_HOME"/.nexus-setup-source.*|"$NEXUS_HOME"/.nexus-lock.*|"$NEXUS_HOME"/.nexus-lock-candidates.*)
        [[ -e "$path" || -L "$path" ]] || continue
        rm -rf -- "$path" || :
        ;;
    esac
  done
}

setup_restore_traps() {
  local saved
  # Clear handlers first: an empty saved definition means the signal was
  # previously at its default action and must not retain Nexus's handler.
  trap - EXIT INT TERM
  for saved in "${SETUP_PREV_EXIT:-}" "${SETUP_PREV_INT:-}" "${SETUP_PREV_TERM:-}"; do
    [[ -n "$saved" ]] && eval "$saved" || :
  done
  SETUP_TRAPS_ACTIVE=0
}

setup_signal_handler() {
  local sig="$1" code
  case "$sig" in INT) code=130 ;; TERM) code=143 ;; *) code=1 ;; esac
  trap - EXIT INT TERM
  SETUP_INTERRUPTED=1
  if [[ -e "$HOME/.claude-backup" || -e "$HOME/.codex-backup" || -e "$LOCK_FILE" || -L "$LOCK_FILE" ]]; then
    error "setup interrupted; retained final/recovery paths: $HOME/.claude-backup $HOME/.codex-backup $LOCK_FILE"
    ((${#SETUP_OWNED_TEMPS[@]})) && error "retained setup temps: ${SETUP_OWNED_TEMPS[*]}"
    ((${#SETUP_OWNED_RECOVERY[@]})) && error "retained setup recovery paths: ${SETUP_OWNED_RECOVERY[*]}"
    error "rerun setup only after reviewing retained paths; correct the issue, then run /nexus:link or \$nexus-link (CLI: $NEXUS_HOME/scripts/nexus link)"
  else
    setup_cleanup_owned_paths
    error "setup interrupted before publication; no final backups or Nexus lock were published; rerun setup"
  fi
  setup_lock_release || :
  exit "$code"
}

setup_exit_handler() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 )); then
    if [[ -e "$HOME/.claude-backup" || -e "$HOME/.codex-backup" || -e "$LOCK_FILE" || -L "$LOCK_FILE" ]]; then
      error "setup failed; retained final/recovery paths: $HOME/.claude-backup $HOME/.codex-backup $LOCK_FILE"
      ((${#SETUP_OWNED_TEMPS[@]})) && error "retained setup temps: ${SETUP_OWNED_TEMPS[*]}"
      ((${#SETUP_OWNED_RECOVERY[@]})) && error "retained setup recovery paths: ${SETUP_OWNED_RECOVERY[*]}"
    else
      setup_cleanup_owned_paths
    fi
  fi
  setup_lock_release || :
  setup_restore_traps
  return "$status"
}

setup_install_traps() {
  SETUP_PREV_EXIT="$(trap -p EXIT)"
  SETUP_PREV_INT="$(trap -p INT)"
  SETUP_PREV_TERM="$(trap -p TERM)"
  trap 'setup_exit_handler' EXIT
  trap 'setup_signal_handler INT' INT
  trap 'setup_signal_handler TERM' TERM
  SETUP_TRAPS_ACTIVE=1
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
  SETUP_PHASE='lock_published'
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
  setup_restore_traps
  SETUP_PHASE='idle'
  return "$status"
}
