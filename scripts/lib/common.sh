nexus_init() {
  NEXUS_HOME="${NEXUS_HOME:-$HOME/.nexus}"
  LOCK_FILE="$NEXUS_HOME/skill-lock.json"
  CANONICAL_DIR="$HOME/.agents/skills"
  CUSTOM_ROOT="$HOME/.custom-skills"
  CUSTOM_WORKSPACES="$CUSTOM_ROOT/.workspaces"
  CLAUDE_SKILLS="$HOME/.claude/skills"
  CODEX_SKILLS="$HOME/.codex/skills"
  declare -g -a CONTROL_SKILLS=(nexus-setup nexus-link nexus-install nexus-new)
  ERRORS=0
  CANONICAL_CURRENT=''
  DISCOVERED_LOCK=''
  SETUP_CLAUDE_BACKUP=''
  SETUP_CODEX_BACKUP=''
  declare -g -a SETUP_LOCK_NAMES=()
  declare -g -a SETUP_OWNED_TEMPS=()
  declare -g -a SETUP_OWNED_RECOVERY=()
  SETUP_PHASE='idle'
  SETUP_INTERRUPTED=0
  SETUP_MUTEX=''
  declare -g -A DESIRED_SET=()
  declare -g -a DESIRED_NAMES=()
  declare -g -A CUSTOM_SET=()
}

info() { printf 'nexus: %s\n' "$*"; }
error() { printf 'nexus: error: %s\n' "$*" >&2; ERRORS=$((ERRORS + 1)); }
resolved_link_target() {
  local link="$1" raw parent
  raw="$(readlink -- "$link")" || return 1
  if [[ "$raw" == /* ]]; then
    realpath -m -- "$raw"
  else
    parent="$(dirname -- "$link")"
    realpath -m -- "$parent/$raw"
  fi
}

links_exactly_to() {
  local link="$1" target="$2" installed expected
  [[ -L "$link" ]] || return 1
  installed="$(realpath -e -- "$link")" || return 1
  expected="$(realpath -e -- "$target")" || return 1
  [[ "$installed" == "$expected" ]]
}

path_is_within() {
  local candidate="$1" root="$2"
  [[ "$candidate" == "$root" || "$candidate" == "$root"/* ]]
}

is_managed_path() {
  local path="$1" candidate_lexical candidate_resolved root root_lexical root_resolved
  candidate_lexical="$(realpath -m -s -- "$path")"
  candidate_resolved="$(realpath -m -- "$path")"
  for root in "$CANONICAL_DIR" "$NEXUS_HOME/skills" "$CUSTOM_ROOT"; do
    root_lexical="$(realpath -m -s -- "$root")"
    root_resolved="$(realpath -m -- "$root")"
    path_is_within "$candidate_lexical" "$root_lexical" ||
      path_is_within "$candidate_lexical" "$root_resolved" ||
      path_is_within "$candidate_resolved" "$root_lexical" ||
      path_is_within "$candidate_resolved" "$root_resolved" || continue
    return 0
  done
  return 1
}

is_managed_link() {
  local link="$1" raw parent lexical resolved
  raw="$(readlink -- "$link")" || return 1
  parent="$(dirname -- "$link")"
  if [[ "$raw" == /* ]]; then
    lexical="$(realpath -m -s -- "$raw")"
  else
    lexical="$(realpath -m -s -- "$parent/$raw")"
  fi
  resolved="$(resolved_link_target "$link")" || return 1
  is_managed_path "$lexical" || is_managed_path "$resolved"
}

skill_target() {
  local name="$1"
  case "$name" in
    nexus-setup|nexus-link|nexus-install|nexus-new) printf '%s\n' "$NEXUS_HOME/skills/$name" ; return 0 ;;
  esac
  if [[ -n "${CUSTOM_SET[$name]+present}" ]]; then
    printf '%s\n' "$CUSTOM_ROOT/$name"
  else
    printf '%s\n' "$CANONICAL_DIR/$name"
  fi
}

command_requirements() {
  local command
  for command in jq python3 cp mv mktemp realpath cmp find sort stat sha256sum awk wc chmod chown touch; do
    command -v -- "$command" >/dev/null 2>&1 || {
      error "required command not available: $command"
      return 1
    }
  done
  return 0
}

desired_contains() {
  [[ -n "${DESIRED_SET[$1]+present}" ]]
}

stage_move() {
  mv -Tf -- "$1" "$2"
}

put_link() {
  local target="$1" link="$2" force="${3:-false}" parent relative tmp current backup original
  CURRENT_LINK="$link"
  if [[ ! -e "$target" ]]; then
    error "missing link target: $target"
    return 1
  fi
  parent="$(dirname -- "$link")"
  mkdir -p -- "$parent" || { error "cannot create parent: $parent"; return 1; }

  if [[ -L "$link" ]]; then
    current="$(resolved_link_target "$link")" || current=''
    if links_exactly_to "$link" "$target"; then
      return 0
    fi
    if [[ "$force" != true ]] && ! is_managed_link "$link"; then
      error "collision at $link (external symlink)"
      return 1
    fi
  elif [[ -e "$link" ]]; then
    if [[ "$force" != true ]]; then
      error "collision at $link"
      return 1
    fi
  fi

  relative="$(realpath --relative-to="$parent" -- "$target")" || {
    error "cannot calculate relative target for $link"; return 1;
  }
  tmp="$parent/.nexus-tmp.$$.${RANDOM}"
  ln -s -- "$relative" "$tmp" || { error "cannot create temporary link for $link"; return 1; }
  if ! links_exactly_to "$tmp" "$target"; then
    [[ -L "$tmp" ]] && rm -- "$tmp"
    error "staged link verification failed: $link"
    return 1
  fi

  if [[ -e "$link" && ! -L "$link" ]]; then
    backup="$(mktemp -d -- "$parent/.nexus-backup.XXXXXX")" || {
      [[ -L "$tmp" ]] && rm -- "$tmp"
      error "cannot reserve recovery container for $link"
      return 1
    }
    if [[ "$(dirname -- "$backup")" != "$parent" || "$(basename -- "$backup")" != .nexus-backup.* ||
          ! -d "$backup" || "$(find "$backup" -mindepth 1 -maxdepth 1 -print -quit)" != '' ]]; then
      [[ -d "$backup" ]] && rmdir -- "$backup"
      [[ -L "$tmp" ]] && rm -- "$tmp"
      error "invalid recovery container: $backup"
      return 1
    fi
    original="$backup/original"
    if ! mv -- "$link" "$original"; then
      [[ -L "$tmp" ]] && rm -- "$tmp"
      rmdir -- "$backup" || error "recovery container retained: $backup"
      error "cannot stage existing collision: $link"
      return 1
    fi
    if ! stage_move "$tmp" "$link"; then
      if ! stage_move "$original" "$link"; then
        error "recovery container retained: $backup"
        [[ -L "$tmp" ]] && rm -- "$tmp"
        return 1
      fi
      rmdir -- "$backup" || error "recovery container retained: $backup"
      [[ -L "$tmp" ]] && rm -- "$tmp"
      error "cannot install link: $link"
      return 1
    fi
    current=''
    if ! links_exactly_to "$link" "$target"; then
      rm -- "$link" || error "cannot remove incorrect link: $link"
      if ! stage_move "$original" "$link"; then
        error "recovery container retained: $backup"
        return 1
      fi
      rmdir -- "$backup" || error "recovery container retained: $backup"
      error "link verification failed: $link"
      return 1
    fi
    rm -rf -- "$original" || { error "recovery container retained: $backup"; return 1; }
    rmdir -- "$backup" || { error "recovery container retained: $backup"; return 1; }
    return 0
  fi

  if ! stage_move "$tmp" "$link"; then
    [[ -L "$tmp" ]] && rm -- "$tmp"
    error "cannot install link: $link"
    return 1
  fi
  if ! links_exactly_to "$link" "$target"; then
    error "link verification failed: $link"
    return 1
  fi
  return 0
}
