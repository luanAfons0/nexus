safe_skill_name() {
  local name="$1"
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "$name" != . && "$name" != .. ]]
}

register_validator_snapshot() {
  local path="$1"
  if [[ "${SETUP_TRAPS_ACTIVE:-0}" == 1 ]] && declare -F setup_register_temp >/dev/null 2>&1; then
    setup_register_temp "$path"
  fi
}

unregister_validator_snapshot() {
  local path="$1"
  if [[ "${SETUP_TRAPS_ACTIVE:-0}" == 1 ]] && declare -F setup_unregister_path >/dev/null 2>&1; then
    setup_unregister_path "$path"
  fi
}

cleanup_lock_snapshot() {
  local snapshot_dir="$1" snapshot="$snapshot_dir/lock.json" names="$snapshot_dir/names"
  if [[ ! -d "$snapshot_dir" || "$(dirname -- "$snapshot_dir")" != "$NEXUS_HOME" ||
        "$(basename -- "$snapshot_dir")" != .nexus-lock.* ]]; then
    error "invalid lock snapshot directory: $snapshot_dir"
    return 1
  fi
  rm -f -- "$snapshot" "$names"
  if ! rmdir -- "$snapshot_dir"; then
    error "cannot clean lock snapshot directory: $snapshot_dir"
    return 1
  fi
  unregister_validator_snapshot "$snapshot_dir"
  return 0
}

load_validated_lock_names() {
  local file="$1" output_array_name="$2" snapshot_dir='' snapshot names name marker_seen=0
  local -n output_array="$output_array_name"
  output_array=()
  if [[ ! -f "$file" || -L "$file" ]]; then
    error "invalid version-3 lock: expected regular file at $file"
    return 1
  fi
  snapshot_dir="$(mktemp -d -- "$NEXUS_HOME/.nexus-lock.XXXXXX")" || {
    error "cannot create lock snapshot directory under $NEXUS_HOME"
    return 1
  }
  register_validator_snapshot "$snapshot_dir"
  snapshot="$snapshot_dir/lock.json"
  names="$snapshot_dir/names"
  if ! cp -- "$file" "$snapshot"; then
    error "cannot snapshot lock file: $file"
    cleanup_lock_snapshot "$snapshot_dir" || :
    return 1
  fi
  if ! jq -er -s '
    def valid_lock:
      type == "object" and
      (.version == 3 and (.version | type) == "number") and
      (.skills | type == "object") and
      all(.skills | keys[];
        test("^[A-Za-z0-9][A-Za-z0-9._-]*\\z") and . != "." and . != ".." and
        . != "nexus-setup" and . != "nexus-link" and . != "nexus-install");
    if length == 1 and (.[0] | valid_lock) then
      ((.[0].skills | keys[]), "__NEXUS_LOCK_END__")
    else
      error("invalid version-3 lock")
    end
  ' "$snapshot" >"$names"; then
    error "invalid version-3 lock: $file must be one JSON object with numeric version 3, object skills, and safe skill names"
    cleanup_lock_snapshot "$snapshot_dir" || :
    return 1
  fi
  while IFS= read -r name || [[ -n "$name" ]]; do
    if [[ "$name" == __NEXUS_LOCK_END__ ]]; then
      marker_seen=1
      continue
    fi
    if (( marker_seen != 0 )) || ! safe_skill_name "$name"; then
      error "invalid version-3 lock: unsafe emitted skill name"
      cleanup_lock_snapshot "$snapshot_dir" || :
      return 1
    fi
    output_array+=("$name")
  done <"$names"
  if (( marker_seen == 0 )); then
    error "invalid version-3 lock: key extraction did not complete"
    cleanup_lock_snapshot "$snapshot_dir" || :
    return 1
  fi
  cleanup_lock_snapshot "$snapshot_dir" || return 1
  return 0
}

lock_semantic_json() {
  local file="$1"
  # Callers must validate with load_validated_lock_names first, which rejects
  # streams and unsafe names.  This only supplies a stable equality form.
  jq -S -c . "$file"
}

discover_lock() {
  local -a candidates=(
    "$HOME/.agents/.skill-lock.json"
    "$HOME/.agents/skill-lock.json"
    "$HOME/.skills/.skill-lock.json"
    "$HOME/.skills/skill-lock.json"
  )
  local candidate snapshot first='' first_snapshot='' first_json='' candidate_json
  local -a names=() found=() invalid=() valid=() valid_snapshots=()
  DISCOVERED_LOCK=''
  DISCOVERED_LOCK_SNAPSHOT=''
  DISCOVERY_SNAPSHOT_DIR="$(mktemp -d -- "$NEXUS_HOME/.nexus-lock-candidates.XXXXXX")" || {
    error "cannot reserve candidate lock snapshots"
    return 1
  }
  setup_register_temp "$DISCOVERY_SNAPSHOT_DIR"
  for candidate in "${candidates[@]}"; do
    [[ -e "$candidate" || -L "$candidate" ]] || continue
    found+=("$candidate")
    snapshot="$DISCOVERY_SNAPSHOT_DIR/${#found[@]}.json"
    if ! cp -- "$candidate" "$snapshot" || ! cmp -s -- "$candidate" "$snapshot"; then
      error "cannot snapshot setup lock candidate: $candidate"
      invalid+=("$candidate")
      continue
    fi
    if ! load_validated_lock_names "$snapshot" names; then
      invalid+=("$candidate")
      continue
    fi
    candidate_json="$(lock_semantic_json "$snapshot")" || {
      error "cannot canonicalize lock candidate: $candidate"
      return 1
    }
    if [[ -z "$first" ]]; then
      first="$candidate"
      first_snapshot="$snapshot"
      first_json="$candidate_json"
    fi
    valid+=("$candidate")
    valid_snapshots+=("$snapshot")
  done
  if (( ${#invalid[@]} != 0 )); then
    error "invalid setup lock candidates: ${invalid[*]}"
    return 1
  fi
  if [[ -z "$first" ]]; then
    error "no version-3 skill lock found (checked: ${candidates[*]})"
    return 1
  fi
  for snapshot in "${valid_snapshots[@]}"; do
    candidate_json="$(lock_semantic_json "$snapshot")" || {
      error "cannot canonicalize lock candidate snapshot: $snapshot"
      return 1
    }
    if [[ "$candidate_json" != "$first_json" ]]; then
      error "conflicting setup lock candidates: ${valid[*]}"
      return 1
    fi
  done
  DISCOVERED_LOCK="$first"
  DISCOVERED_LOCK_SNAPSHOT="$first_snapshot"
  return 0
}

cleanup_discovered_lock_snapshots() {
  [[ -n "${DISCOVERY_SNAPSHOT_DIR:-}" && -d "$DISCOVERY_SNAPSHOT_DIR" &&
     "$(dirname -- "$DISCOVERY_SNAPSHOT_DIR")" == "$NEXUS_HOME" &&
     "$(basename -- "$DISCOVERY_SNAPSHOT_DIR")" == .nexus-lock-candidates.* ]] || return 0
  rm -rf -- "$DISCOVERY_SNAPSHOT_DIR" || {
    error "candidate lock snapshots retained: $DISCOVERY_SNAPSHOT_DIR"
    return 1
  }
  if [[ "${SETUP_TRAPS_ACTIVE:-0}" == 1 ]] && declare -F setup_unregister_path >/dev/null 2>&1; then
    setup_unregister_path "$DISCOVERY_SNAPSHOT_DIR"
  fi
  DISCOVERY_SNAPSHOT_DIR=''
}
