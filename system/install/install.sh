#!/usr/bin/env bash
# install.sh — REVIEW-REQUIRED (system/CLAUDE.md): runs as root, once per install or update.
#
# Turns a fresh Debian 12/13 or Ubuntu 24.04 machine (amd64, arm64) into a running platform, or
# updates an installed one to this release. Run from the unpacked release archive:
#
#   sudo ./install.sh [--yes] [--no-tailscale]
#
#   --yes            install missing programs (Node.js, Docker, Tailscale, Borg) without asking
#   --no-tailscale   no HTTPS: the app is reachable only on this machine (tests)
#
# Every step checks first and changes only what's missing or outdated: running it again is safe.
# It never deletes a user's data. Design: docs/plans/installer.md.
set -euo pipefail
umask 0022

RELEASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSUME_YES=0
USE_TAILSCALE=1
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --no-tailscale) USE_TAILSCALE=0 ;;
    -h | --help)
      sed -n '2,14s/^# \{0,1\}//p' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s (see --help)\n' "$arg" >&2
      exit 2
      ;;
  esac
done

LIB="$RELEASE/system/install/lib"
[[ -f "$RELEASE/VERSION" && -d "$RELEASE/app" && -d "$LIB" ]] ||
  { printf 'Run it from the unpacked release archive (npm run release builds one).\n' >&2; exit 2; }
# shellcheck source=lib/common.sh
. "$LIB/common.sh"
# shellcheck source=lib/checks.sh
. "$LIB/checks.sh"
# shellcheck source=lib/packages.sh
. "$LIB/packages.sh"
# shellcheck source=lib/files.sh
. "$LIB/files.sh"
# shellcheck source=lib/platform.sh
. "$LIB/platform.sh"

check_machine
check_version
ensure_packages
ensure_user
ensure_folders
write_settings
if [[ -n "$OLD_VERSION" ]]; then
  # The app stops first: nothing writes to the database while it's backed up and migrated.
  systemctl stop homelab.service 2>/dev/null || true
fi
install_platform_files
start_platform
backup_database
# Migrated from the new release before it replaces the old: a failure leaves the old one.
migrate_database
install_release
setup_https
start_app
printf '%s\n' "$NEW_VERSION" | write_file "$ETC/version" root:root 0644
print_result
