#!/usr/bin/env bash
# get-laris.sh — downloads the latest Laris release, checks it's genuine, and installs it:
#
#   curl -fsSL <release address>/get-laris.sh -o get-laris.sh   (read it), then: bash get-laris.sh
#
# Options go to install.sh (--yes; see its --help). Before anything from the
# download runs: the release's manifest is checked against the public key below (minisign's
# format, checked with openssl), then the archive against the size and SHA-256 the manifest
# carries. Design: docs/plans/install_and_update.md.
set -euo pipefail
umask 0022

# Filled in when the release is built (scripts/release.mjs).
RELEASE_URL='@RELEASE_URL@'
PUBLIC_KEY='@PUBLIC_KEY@'
MAX_MANIFEST_BYTES=4096

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

as_root() { if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo "$@"; fi; }

for tool in curl openssl tar sha256sum base64 cmp; do
  command -v "$tool" >/dev/null || die "$tool is needed (sudo apt install $tool)"
done
[[ "$(id -u)" == 0 ]] || command -v sudo >/dev/null || die 'Run it as root, or install sudo'

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# HTTPS only, redirects too (the signature decides what's genuine, not the address).
fetch() {
  curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --max-filesize "$3" -o "$2" "$1"
}

bytes() { wc -c <"$1" | tr -d ' '; }

# A minisign signature (prehashed Ed25519) of $1 in $2, by PUBLIC_KEY: four lines — a comment;
# "ED", the key's id and the signature of the file's BLAKE2b-512; the trusted comment; the
# signature of both.
verify() {
  local file="$1" sig="$2" trusted
  printf '%s' "$PUBLIC_KEY" | base64 -d >"$WORK/key" 2>/dev/null || return 1
  [[ "$(bytes "$WORK/key")" == 42 && "$(head -c 2 "$WORK/key")" == Ed ]] || return 1
  # The raw Ed25519 key as DER, the form openssl reads.
  { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; tail -c 32 "$WORK/key"; } >"$WORK/key.der"

  [[ "$(wc -l <"$sig" | tr -d ' ')" == 4 ]] || return 1
  sed -n 2p "$sig" | base64 -d >"$WORK/sig" 2>/dev/null || return 1
  [[ "$(bytes "$WORK/sig")" == 74 && "$(head -c 2 "$WORK/sig")" == ED ]] || return 1
  cmp -s <(head -c 10 "$WORK/sig" | tail -c 8) <(head -c 10 "$WORK/key" | tail -c 8) || return 1
  tail -c 64 "$WORK/sig" >"$WORK/sig.bin"
  openssl dgst -blake2b512 -binary "$file" >"$WORK/digest"
  openssl pkeyutl -verify -pubin -keyform DER -inkey "$WORK/key.der" -rawin \
    -in "$WORK/digest" -sigfile "$WORK/sig.bin" >/dev/null 2>&1 || return 1

  trusted="$(sed -n 3p "$sig")"
  [[ "$trusted" == 'trusted comment: '* ]] || return 1
  { cat "$WORK/sig.bin"; printf '%s' "${trusted#trusted comment: }"; } >"$WORK/global"
  sed -n 4p "$sig" | base64 -d >"$WORK/global.sig" 2>/dev/null || return 1
  [[ "$(bytes "$WORK/global.sig")" == 64 ]] || return 1
  openssl pkeyutl -verify -pubin -keyform DER -inkey "$WORK/key.der" -rawin \
    -in "$WORK/global" -sigfile "$WORK/global.sig" >/dev/null 2>&1
}

# A field of the manifest (scripts/sign-release.mjs writes one per line).
field() { sed -n "s/^  \"$1\": \"\{0,1\}\([^\"]*\)\"\{0,1\},\{0,1\}\$/\1/p" "$WORK/latest.json"; }

printf 'Checking the latest release at %s\n' "$RELEASE_URL"
fetch "$RELEASE_URL/latest/download/latest.json" "$WORK/latest.json" "$MAX_MANIFEST_BYTES" ||
  die 'The release information could not be downloaded'
fetch "$RELEASE_URL/latest/download/latest.json.minisig" "$WORK/latest.json.minisig" "$MAX_MANIFEST_BYTES" ||
  die 'The release signature could not be downloaded'
verify "$WORK/latest.json" "$WORK/latest.json.minisig" ||
  die 'The release information is not signed by the Laris release key — nothing was installed'

version="$(field version)"
archive="$(field archive)"
sha256="$(field sha256)"
size="$(field size)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$archive" == "laris-$version.tar.gz" &&
  "$sha256" =~ ^[0-9a-f]{64}$ && "$size" =~ ^[1-9][0-9]*$ ]] ||
  die 'The release information is malformed'

printf 'Downloading Laris %s\n' "$version"
fetch "$RELEASE_URL/download/v$version/$archive" "$WORK/$archive" "$size" ||
  die 'The release could not be downloaded'
[[ "$(bytes "$WORK/$archive")" == "$size" ]] || die 'The download has the wrong size'
[[ "$(sha256sum "$WORK/$archive" | cut -d' ' -f1)" == "$sha256" ]] ||
  die 'The download does not match its signed fingerprint — nothing was installed'

# Unpacked as root, into root's own folder: the files keep the archive's owner (root).
unpack="$(as_root mktemp -d /tmp/laris-install.XXXXXX)"
as_root tar -xzf "$WORK/$archive" -C "$unpack"
status=0
# Piped into bash, stdin is this script: install.sh's questions read the terminal.
if [[ ! -t 0 ]] && (: </dev/tty) 2>/dev/null; then
  as_root "$unpack/laris-$version/install.sh" "$@" </dev/tty || status=$?
else
  as_root "$unpack/laris-$version/install.sh" "$@" || status=$?
fi
as_root rm -rf "$unpack"
exit "$status"
