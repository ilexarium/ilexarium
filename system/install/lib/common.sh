# system/install/lib/common.sh — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
# Output, questions, and writing files safely. Sourced by install.sh.

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# Asks before changing the system outside our own files (installing packages); --yes answers.
# An update from the app installs nothing: it stops before anything changed.
confirm() {
  if [[ "$UPDATE" == 1 ]]; then die "Needed first: $1 — an update from Ilexarium installs no programs; update by hand (get-ilex.sh) or install it, then update again"; fi
  if [[ "$ASSUME_YES" == 1 ]]; then return 0; fi
  if [[ ! -t 0 ]]; then die "$1 — run again with --yes to agree without being asked"; fi
  local answer
  read -r -p "    $1 [y/N] " answer
  [[ "$answer" == y || "$answer" == Y ]]
}

# Progress for ilex-update (an update from the app), which reads the @@ lines.
marker() {
  if [[ "$UPDATE" == 1 ]]; then printf '@@%s\n' "$*"; fi
}

# Writes stdin to a file atomically: a temporary file beside it, owner and mode set first, then
# renamed into place — never a moment with the content readable by the wrong user.
write_file() {
  local dest="$1" owner="$2" mode="$3" tmp
  tmp="$(mktemp "$(dirname "$dest")/.ilex-install.XXXXXX")"
  chown "$owner" "$tmp"
  chmod "$mode" "$tmp"
  cat >"$tmp"
  mv -f "$tmp" "$dest"
}

# A folder, made if missing, with its owner and mode (set again on every run).
ensure_dir() {
  local dir="$1" owner="$2" mode="$3"
  mkdir -p "$dir"
  chown "$owner" "$dir"
  chmod "$mode" "$dir"
}

# Replaces a whole folder tree with a copy of another, root-owned and writable only by root:
# copied beside it first, then swapped in, the old one removed last.
replace_tree() {
  local src="$1" dest="$2"
  rm -rf "$dest.new"
  cp -a "$src" "$dest.new"
  chown -R root:root "$dest.new"
  chmod -R go-w,a+rX "$dest.new"
  if [[ -e "$dest" ]]; then
    rm -rf "$dest.old"
    mv "$dest" "$dest.old"
  fi
  mv "$dest.new" "$dest"
  rm -rf "$dest.old"
}

# The root programs' lock, as lib/lock.mts takes it: a file holding its owner's pid and start time,
# linked into place — one privileged operation at a time (a backup, a restore, a disk change, an
# install). The start time tells a pid the kernel gave to another process since from the holder.
ROOT_LOCK=/run/ilex/compose.lock

# Process $1's start time (clock ticks since boot, /proc/<pid>/stat's 22nd field), or nothing.
start_time() {
  local stat fields
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 0
  # The name in parentheses may hold spaces: the fields after its last ')'.
  read -ra fields <<<"${stat##*) }"
  printf '%s' "${fields[19]:-}"
}

# The pid holding lock $1, or nothing when it's free or its owner is gone (a pid without its start
# time is an older writer's). One without a pid counts for a minute, as in lock.mts.
lock_owner() {
  local text pid start
  text="$(cat "$1" 2>/dev/null || true)"
  if [[ "$text" =~ ^([1-9][0-9]*)( ([0-9]+))?$ ]]; then
    pid="${BASH_REMATCH[1]}" start="${BASH_REMATCH[3]}"
    if [[ -n "$start" && "$(start_time "$pid")" != "$start" ]]; then return 0; fi
    if kill -0 "$pid" 2>/dev/null; then printf '%s' "$pid"; fi
  elif [[ -e "$1" ]] && (($(date +%s) - $(stat -c %Y "$1") < 60)); then
    printf unknown
  fi
}

# Takes lock $1 until this script ends, or fails while a living owner holds it.
take_lock() {
  local lock="$1" own="$1.$$" ino
  mkdir -p "$(dirname "$lock")"
  local start
  start="$(start_time $$)"
  printf '%s' "$$${start:+ $start}" >"$own"
  for _ in 1 2; do
    if ln "$own" "$lock" 2>/dev/null; then
      rm -f "$own"
      LOCK_TAKEN="$lock"
      trap 'rm -f "$LOCK_TAKEN"' EXIT
      return 0
    fi
    ino="$(stat -c %i "$lock" 2>/dev/null || true)"
    if [[ -n "$(lock_owner "$lock")" ]]; then break; fi
    # Its owner died: taken over — only the lock judged dead, never one taken meanwhile.
    if [[ "$(stat -c %i "$lock" 2>/dev/null || true)" == "$ino" ]]; then rm -f "$lock"; fi
  done
  rm -f "$own"
  return 1
}

# Random letters and digits (hex), for passwords: safe in URLs and SQL without quoting.
random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

# The value of KEY in a KEY=value file, or nothing (also when the file doesn't exist yet).
read_setting() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n1 || true; }
