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
confirm() {
  if [[ "$ASSUME_YES" == 1 ]]; then return 0; fi
  if [[ ! -t 0 ]]; then die "$1 — run again with --yes to agree without being asked"; fi
  local answer
  read -r -p "    $1 [y/N] " answer
  [[ "$answer" == y || "$answer" == Y ]]
}

# Writes stdin to a file atomically: a temporary file beside it, owner and mode set first, then
# renamed into place — never a moment with the content readable by the wrong user.
write_file() {
  local dest="$1" owner="$2" mode="$3" tmp
  tmp="$(mktemp "$(dirname "$dest")/.laris-install.XXXXXX")"
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

# Random letters and digits (hex), for passwords: safe in URLs and SQL without quoting.
random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

# The value of KEY in a KEY=value file, or nothing (also when the file doesn't exist yet).
read_setting() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n1 || true; }
