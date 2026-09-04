# Shared flow that runs after an upstream `npx skills` command succeeds.
# Snapshot the upstream lock, validate it, verify canonical SKILL.md trees,
# publish the exact snapshot as the Nexus lock, then reconcile links.
# The optional first argument names a function called with the validated
# snapshot path and the lock names array name; a non-zero return refuses
# publication and leaves the Nexus lock unchanged. The optional second
# argument, `true`, accepts a lock that selects no skills; install refuses
# that, remove of the last skill needs it.

upstream_lock_path() {
  printf '%s\n' "$HOME/.agents/.skill-lock.json"
}

upstream_atomic_lock_copy() {
  local source="$1" destination="$2" parent temp
  parent="$(dirname -- "$destination")"
  mkdir -p -- "$parent" || { error "cannot create lock destination: $parent"; return 1; }
  temp="$(mktemp -- "$parent/.nexus-install-copy.XXXXXX")" || {
    error "cannot reserve atomic lock copy"; return 1;
  }
  if ! cp -- "$source" "$temp" || ! cmp -s -- "$source" "$temp"; then
    if ! rm -f -- "$temp" || [[ -e "$temp" || -L "$temp" ]]; then
      error "install scratch retained: $temp"
      return 1
    fi
    error "atomic upstream lock copy verification failed: $destination"
    return 1
  fi
  if ! mv -Tf -- "$temp" "$destination"; then
    if ! rm -f -- "$temp" || [[ -e "$temp" || -L "$temp" ]]; then
      error "install scratch retained: $temp"
      return 1
    fi
    error "cannot publish upstream lock: $destination"
    return 1
  fi
  if ! cmp -s -- "$source" "$destination"; then
    error "upstream lock post-publication verification failed: $destination"
    return 1
  fi
  return 0
}

cleanup_upstream_snapshot() {
  local path="$1"
  [[ -e "$path" || -L "$path" ]] || return 0
  if ! rm -f -- "$path" || [[ -e "$path" || -L "$path" ]]; then
    error "install scratch retained: $path"
    return 1
  fi
  return 0
}

publish_upstream_lock_and_link() {
  local check="${1:-}" allow_empty="${2:-false}" status=0 cleanup_status=0 name target snapshot=''
  local upstream_lock
  local -a lock_names=()
  upstream_lock="$(upstream_lock_path)"
  snapshot="$(mktemp -- "$NEXUS_HOME/.nexus-install-lock.XXXXXX")" || {
    error "cannot reserve upstream lock snapshot"
    return 1
  }
  if ! cp -- "$upstream_lock" "$snapshot" ||
     ! cmp -s -- "$upstream_lock" "$snapshot"; then
    cleanup_upstream_snapshot "$snapshot" || :
    error "cannot snapshot upstream skill lock: $upstream_lock"
    return 1
  fi

  if ! load_validated_lock_names "$snapshot" lock_names; then
    error "upstream did not produce a valid version-3 skill lock"
    status=1
  elif (( ${#lock_names[@]} == 0 )) && [[ "$allow_empty" != true ]]; then
    error "upstream skill lock selected no skills"
    status=1
  fi
  if (( status == 0 )); then
    for name in "${lock_names[@]}"; do
      target="$CANONICAL_DIR/$name"
      [[ -f "$target/SKILL.md" ]] || {
        error "upstream lock skill is missing SKILL.md: $target/SKILL.md"
        status=1
        break
      }
    done
  fi
  if (( status == 0 )) && [[ -n "$check" ]]; then
    "$check" "$snapshot" lock_names || status=1
  fi
  if (( status == 0 )); then
    upstream_atomic_lock_copy "$snapshot" "$LOCK_FILE" || status=1
  fi
  if (( status == 0 )); then
    link_all false || status=1
  fi
  cleanup_upstream_snapshot "$snapshot" || cleanup_status=$?
  (( cleanup_status != 0 )) && status=1
  return "$status"
}
