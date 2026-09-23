# check subcommand. Ask GitHub, read-only, which Installed Skills are Behind:
# a Skill is Behind when the folder it came from has a commit newer than the
# moment that Skill was installed or last updated.
#
# The check applies nothing. No Skill, no Managed Link and no line of the
# Nexus Lock moves, so a check that runs every weekday morning can never
# change an Agent Context while nobody is watching. Applying stays the update
# a person asks for.
#
# Commit dates are the road because nothing else can answer the question:
# `skillFolderHash` is upstream `npx skills`' own hash, its algorithm exists
# nowhere in Nexus, upstream has no check-only command, and the lock records
# no commit, tag or version. The date of the last commit that touched a
# Skill's folder is what GitHub can say about that folder without fetching it.
#
# The one file the check writes is the Check Result beside the lock, which Git
# ignores. It is never part of the Nexus Lock: the lock is authoritative and
# versioned (ADR 0001), while a check result goes stale by itself and would
# dirty the working tree every morning.
#
# `--last` prints that file and asks GitHub nothing. It is the road for a
# reader rather than an asker: the Plugin Page marks its rows from the Check
# Result every time somebody opens it, and a page that reached GitHub on each
# load would be a check nobody asked for.

# Fields reach the loop separated by the unit separator rather than a tab,
# because bash folds a run of tabs into one delimiter and a Skill whose
# SKILL.md sits at the root of its repository has an empty folder field.
CHECK_SEPARATOR=$'\037'

# `gh` is how Nexus reaches GitHub: it is authenticated already and is this
# house's tool. Both refusals come before any file is read, because a check
# that cannot ask is not a check, and because the sentence a person needs is
# about their own machine.
ensure_gh() {
  command -v gh >/dev/null 2>&1 || {
    error "the GitHub CLI is not available: install gh, then run gh auth login"
    return 1
  }
  gh auth status >/dev/null 2>&1 || {
    error "the GitHub CLI is not logged in: run gh auth login"
    return 1
  }
  return 0
}

parse_check_args() {
  CHECK_JSON=false
  CHECK_LAST=false
  local arg
  for arg in "$@"; do
    case "$arg" in
      --json) CHECK_JSON=true ;;
      --last) CHECK_LAST=true ;;
      *)
        usage >&2
        return 2 ;;
    esac
  done
  return 0
}

# One jq pass over the validated lock: the name, the repository, the folder
# and the moment each Installed Skill was installed or last updated. Rows come
# out grouped by repository, so the calls to one repository happen together.
#
# The folder, not the recorded `skillPath`, is what GitHub is asked about: a
# Skill is its folder, so a changed reference file beside SKILL.md is upstream
# moving on just as much as a changed SKILL.md. A Skill whose SKILL.md sits at
# the root of its repository has no folder, and the whole repository answers.
check_lock_rows() {
  jq -r --arg sep "$CHECK_SEPARATOR" '
    .skills | to_entries
    | map({
        name: .key,
        source: (.value.source // ""),
        kind: (.value.sourceType // ""),
        folder: ((.value.skillPath // "") | if test("/") then sub("/[^/]*$"; "") else "" end),
        updated: (.value.updatedAt // .value.installedAt // "")
      })
    | sort_by(.source, .name)
    | .[] | [.name, .source, .kind, .folder, .updated] | join($sep)' "$LOCK_FILE"
}

# The last commit that touched one folder of one repository, as an ISO-8601
# moment on stdout. The committer date, not the author date, because it is the
# moment the folder actually moved on the branch a person installs from.
check_last_commit() {
  local source="$1" folder="$2" stderr_file="$3"
  local -a argv=(gh api -X GET "repos/$source/commits" -f per_page=1)
  [[ -n "$folder" ]] && argv+=(-f "path=$folder")
  argv+=(--jq '.[0].commit.committer.date // empty')
  "${argv[@]}" 2>"$stderr_file"
}

check_epoch() {
  date -u -d "$1" +%s 2>/dev/null
}

# What gh said, in one line, so the Check Result explains itself without the
# journal of the run that produced it.
check_first_line() {
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    printf '%s\n' "$line"
    return 0
  done <"$1"
  return 0
}

# One row of the Check Result. `state` is one lowercase word a page can use as
# it is, and `reason` is a sentence, present exactly when the state is
# unknown, because unknown must never read as good news.
check_row_json() {
  local name="$1" state="$2" source="$3" folder="$4" updated="$5" committed="$6" reason="$7"
  jq -c -n --arg name "$name" --arg state "$state" --arg source "$source" \
    --arg folder "$folder" --arg updated "$updated" --arg committed "$committed" \
    --arg reason "$reason" '
    { name: $name, state: $state,
      source: (if $source == "" then null else $source end),
      folder: $folder,
      updatedAt: (if $updated == "" then null else $updated end),
      committedAt: (if $committed == "" then null else $committed end),
      reason: (if $reason == "" then null else $reason end) }'
}

# The Check Result, written whole through a temporary file and one rename, so
# a crash cannot leave half a result where a caller reads a whole one.
check_write_result() {
  local document="$1" tmp
  tmp="$(mktemp -- "$NEXUS_HOME/.nexus-tmp.check.XXXXXX")" || {
    error "cannot create a temporary file in the Nexus home: $NEXUS_HOME"
    return 1
  }
  if ! printf '%s\n' "$document" >"$tmp"; then
    rm -f -- "$tmp"
    error "cannot write the check result: $tmp"
    return 1
  fi
  if ! mv -f -- "$tmp" "$CHECK_FILE"; then
    rm -f -- "$tmp"
    error "cannot replace the check result: $CHECK_FILE"
    return 1
  fi
  return 0
}

# The table a person reads, from the Check Result document. A check that
# just ran and `--last` print it through the same function, so the two roads
# cannot drift into two answers.
check_print_table() {
  local document="$1"
  printf 'name\tstate\tsource\tupdated\tupstream\n'
  printf '%s\n' "$document" | jq -r '.skills[]
    | [ .name, .state, (.source // "-"), (.updatedAt // "-"), (.committedAt // "-") ] | @tsv'
  printf '%s\n' "$document" | jq -r '.skills[] | select(.state == "unknown")
    | "unknown \(.name): \(.reason)"'
  printf '%s\n' "$document" | jq -r --arg file "$CHECK_FILE" '"checked at \(.checkedAt): " +
    "\(.counts.current) current, \(.counts.behind) behind, \(.counts.unknown) unknown (\($file))"'
}

check_answer() {
  local document="$1"
  if [[ "$CHECK_JSON" == true ]]; then
    printf '%s\n' "$document"
    return 0
  fi
  check_print_table "$document"
}

# The Check Result as it stands, with no question asked of anybody. It needs
# neither `gh` nor the lock, because it reaches nothing and judges nothing.
#
# Both refusals are the whole answer: a caller that shows marks must show none
# rather than imply that every Skill is current, so "there is no result" and
# "the result is not a result" each come back as one sentence and exit 1.
check_last_result() {
  local document
  if [[ ! -f "$CHECK_FILE" ]]; then
    error "no check has run yet: run nexus check to write $CHECK_FILE"
    return 1
  fi
  document="$(jq -e 'if (.checkedAt | type) == "string" and (.counts | type) == "object"
      and (.skills | type) == "array" then . else null end' "$CHECK_FILE" 2>/dev/null)" || {
    error "the check result is unreadable: run nexus check to write $CHECK_FILE again"
    return 1
  }
  check_answer "$document"
}

check_skills() {
  local name source kind folder updated committed state reason status
  local upstream_epoch installed_epoch stderr_file='' checked_at document
  local current=0 behind=0 unknown=0
  local -a rows=() lock_names=()

  parse_check_args "$@" || return $?
  if [[ "$CHECK_LAST" == true ]]; then
    check_last_result
    return $?
  fi
  ensure_gh || return 1

  # A missing lock is a refusal, not an empty result: "no skills, nothing
  # behind" is a sentence a caller would act on, and it would not be true.
  if [[ ! -f "$LOCK_FILE" ]]; then
    error "lock is absent: $LOCK_FILE"
    return 1
  fi
  load_validated_lock_names "$LOCK_FILE" lock_names || return 1

  stderr_file="$(mktemp -- "$NEXUS_HOME/.nexus-tmp.check-gh.XXXXXX")" || {
    error "cannot create a temporary file in the Nexus home: $NEXUS_HOME"
    return 1
  }
  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  while IFS="$CHECK_SEPARATOR" read -r name source kind folder updated; do
    [[ -n "$name" ]] || continue
    committed=''
    reason=''
    state=unknown
    if [[ -z "$source" || "$kind" != github ]]; then
      reason="the lock records no GitHub repository for $name"
    elif [[ -z "$updated" ]]; then
      reason="the lock records no install date for $name"
    else
      : >"$stderr_file"
      committed="$(check_last_commit "$source" "$folder" "$stderr_file")"
      status=$?
      if (( status != 0 )); then
        reason="could not reach $source (gh exited $status): $(check_first_line "$stderr_file")"
        committed=''
      elif [[ -z "$committed" ]]; then
        reason="no commit in $source touches ${folder:-the repository}"
      else
        upstream_epoch="$(check_epoch "$committed")"
        installed_epoch="$(check_epoch "$updated")"
        if [[ -z "$upstream_epoch" || -z "$installed_epoch" ]]; then
          reason="cannot compare $updated with $committed"
        elif (( upstream_epoch > installed_epoch )); then
          state=behind
        else
          state=current
        fi
      fi
    fi
    case "$state" in
      current) current=$((current + 1)) ;;
      behind) behind=$((behind + 1)) ;;
      *) unknown=$((unknown + 1)) ;;
    esac
    rows+=("$(check_row_json "$name" "$state" "$source" "$folder" \
      "$updated" "$committed" "$reason")")
  done < <(check_lock_rows)

  rm -f -- "$stderr_file" || { error "check scratch retained: $stderr_file"; return 1; }

  document="$(printf '%s\n' ${rows[@]+"${rows[@]}"} | jq -s --arg at "$checked_at" \
    --argjson current "$current" --argjson behind "$behind" --argjson unknown "$unknown" '
    { checkedAt: $at,
      counts: { current: $current, behind: $behind, unknown: $unknown },
      skills: sort_by(.name) }')" || {
    error "cannot assemble the check result"
    return 1
  }
  check_write_result "$document" || return 1
  check_answer "$document"
}
