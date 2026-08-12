# Test-only fault overrides. This file is sourced exclusively by fake-home subprocesses.
fault_save() { local n="$1"; eval "$(declare -f "$n" | sed "1s/^$n /__fault_orig_$n /")"; }
fault_setup() {
  case "${NEXUS_FAULT:-}" in
    stage|promote|verify|restore) fault_save stage_move; fault_save links_exactly_to ;;
    lock_extract|lock_replace) fault_save load_validated_lock_names ;;
    backup_copy_fail|backup_copy_false|backup_copy_corrupt|backup_root_corrupt|backup_child_corrupt|backup_symlink_corrupt|backup_retry_once|backup_retry_always) fault_save copy_agent_tree ;;
    backup_manifest_count) fault_save backup_manifest ;;
    backup_promote_second|backup_rollback|backup_final_corrupt|backup_promote_ambiguous) fault_save backup_move ;;
    lock_copy_corrupt|lock_post_publish_corrupt) fault_save atomic_copy ;;
    canonical_promote|canonical_restore|canonical_cleanup) fault_save canonical_move ;;
    canonical_cleanup) fault_save cleanup_canonical_temp ;;
  esac
  case "${NEXUS_FAULT:-}" in
    stage|promote|restore) stage_move() { [[ "$NEXUS_FAULT" == stage || "$NEXUS_FAULT" == promote && "$1" == *'/.nexus-tmp.'* || "$NEXUS_FAULT" == restore && ( "$1" == *'/.nexus-tmp.'* || "$1" == */original ) ]] && { [[ "$NEXUS_FAULT" == stage ]] && error 'test seam: staged link creation failed' || error 'test seam: staged move failed'; return 1; }; __fault_orig_stage_move "$@"; } ;;
    verify) links_exactly_to() { return 1; } ;;
    lock_extract) load_validated_lock_names() { error 'test seam: lock key extraction failed'; return 1; } ;;
    lock_replace) load_validated_lock_names() { __fault_orig_load_validated_lock_names "$@" || return; printf '%s\n' '{"version":3,"skills":{"../escape":{}}}' >"$1"; } ;;
    backup_copy_fail) copy_agent_tree() { [[ "$1" == "$HOME/.claude" ]] && { error 'test seam: backup copy failed'; return 1; }; __fault_orig_copy_agent_tree "$@"; } ;;
    backup_copy_false) copy_agent_tree() { mkdir -p -- "$2"; return 0; } ;;
    backup_copy_corrupt) copy_agent_tree() { __fault_orig_copy_agent_tree "$@" || return; printf corrupt >"$2/corrupt"; } ;;
    backup_root_corrupt) copy_agent_tree() { __fault_orig_copy_agent_tree "$@" || return; [[ "$1" == "$HOME/.claude" ]] && { chmod 700 -- "$2"; touch -d '2026-01-01 00:00:00.987654321' -- "$2"; }; } ;;
    backup_child_corrupt) copy_agent_tree() { __fault_orig_copy_agent_tree "$@" || return; [[ "$1" == "$HOME/.claude" ]] && touch -d '2026-01-01 00:00:00.987654321' -- "$2/child"; } ;;
    backup_symlink_corrupt) copy_agent_tree() { __fault_orig_copy_agent_tree "$@" || return; [[ "$1" == "$HOME/.claude" ]] && { rm -- "$2/trailing-newline-link"; ln -s -- literal-target "$2/trailing-newline-link"; }; } ;;
    backup_retry_once) copy_agent_tree() { __fault_orig_copy_agent_tree "$@" || return; if [[ "$1" == "$HOME/.claude" && "${BACKUP_ATTEMPT:-}" == 1 ]]; then printf 'retry-state\n' >>"$1/retry-marker"; fi; return 0; } ;;
    backup_retry_always) copy_agent_tree() { __fault_orig_copy_agent_tree "$@" || return; if [[ "$1" == "$HOME/.claude" ]]; then printf 'unstable-%s\n' "${BACKUP_ATTEMPT:-unknown}" >>"$1/retry-marker"; fi; return 0; } ;;
    backup_manifest_count) backup_manifest() { printf '%s\n' "$1|$2|$3" >>"$HOME/manifest-calls"; __fault_orig_backup_manifest "$@"; } ;;
    backup_promote_second) backup_move() { [[ "$2" == "$HOME/.codex-backup" ]] && { error 'test seam: second backup promotion failed'; return 1; }; __fault_orig_backup_move "$@"; } ;;
    backup_rollback) backup_move() { [[ "$2" == "$HOME/.codex-backup" || "$1" == "$HOME/.claude-backup" ]] && { error 'test seam: backup rollback failed'; return 1; }; __fault_orig_backup_move "$@"; } ;;
    backup_final_corrupt) backup_move() { __fault_orig_backup_move "$@" || return; if [[ "$2" == "$HOME/.codex-backup" ]]; then chmod 600 "$HOME/.claude-backup/.hidden"; fi; return 0; } ;;
    backup_promote_ambiguous) backup_move() { __fault_orig_backup_move "$@" || return; if [[ "$2" == "$HOME/.claude-backup" ]]; then mv -- "$2" "$2.unknown" || return; mkdir -- "$2"; fi; return 0; } ;;
    lock_copy_corrupt) atomic_copy() { error 'atomic copy staging verification failed'; return 1; } ;;
    lock_post_publish_corrupt) atomic_copy() { __fault_orig_atomic_copy "$@" || return; printf corrupt >"$2"; return 1; } ;;
    canonical_promote) canonical_move() { [[ "$1" == *'/.nexus-canonical-tmp.'* ]] && { error 'test seam: canonical promotion failed'; return 1; }; __fault_orig_canonical_move "$@"; } ;;
    canonical_restore) canonical_move() { [[ "$1" == */original || "$1" == *'/.nexus-canonical-tmp.'* ]] && { error 'test seam: canonical restore failed'; return 1; }; __fault_orig_canonical_move "$@"; } ;;
    canonical_cleanup) cleanup_canonical_temp() { error 'test seam: canonical temp cleanup failed'; return 1; }; canonical_move() { [[ "$1" == *'/.nexus-canonical-tmp.'* ]] && { error 'test seam: canonical promotion failed'; return 1; }; [[ "$1" == */original ]] && { error 'test seam: canonical restore failed'; return 1; }; __fault_orig_canonical_move "$@"; } ;;
  esac
  if [[ "${NEXUS_FAULT:-}" == term_pre ]]; then
    fault_save copy_agent_tree
    copy_agent_tree() { __fault_orig_copy_agent_tree "$@" || return; if [[ "$1" == "$HOME/.codex" ]]; then : >"$HOME/pre-handshake"; while [[ ! -e "$HOME/pre-release" ]]; do sleep .02; done; fi; return 0; }
  fi
  if [[ "${NEXUS_FAULT:-}" == term_post ]]; then
    fault_save atomic_copy
    atomic_copy() { __fault_orig_atomic_copy "$@" || return; : >"$HOME/post-handshake"; while [[ ! -e "$HOME/post-release" ]]; do sleep .02; done; }
  fi
}
