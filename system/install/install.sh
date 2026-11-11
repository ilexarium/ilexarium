#!/usr/bin/env bash
# install.sh — runs as root, once per install or update.
#
# Turns a fresh Debian 12/13, Ubuntu 24.04 or Arch Linux machine (amd64, arm64) into a running platform, or
# updates an installed one to this release. Run from the unpacked release archive:
#
#   sudo ./install.sh [--yes]
#
#   --yes            install missing programs (Node.js, Docker, Borg) without asking (on Arch
#                    from the package database as it is — never a system upgrade)
#   --update         an update from the app (ilex-update): installs no programs, asks nothing,
#                    prints its progress as @@ lines
#
# How people reach the machine is theirs: Ilexarium listens where /etc/ilex/app.env says
# (127.0.0.1:3000 at first) and needs an HTTPS proxy of their choice in front of it.
#
# Every step checks first and changes only what's missing or outdated: running it again is safe.
# It never deletes a user's data.
set -euo pipefail
umask 0022

RELEASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSUME_YES=0
UPDATE=0
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --update) UPDATE=1 ;;
    -h | --help)
      sed -n '2,18s/^# \{0,1\}//p' "$0"
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

# The licence's notice, before anything changes (an update from the app has seen it already).
if [[ "$UPDATE" == 0 ]]; then
  info 'Ilexarium comes with ABSOLUTELY NO WARRANTY. It is free software under the GNU GPL,'
  info 'version 3 or later, and you may share it under its terms: see LICENSE.'
fi
check_machine
hold_lock
check_version
ensure_packages
marker phase checked
ensure_user
ensure_folders
# The same version again (a repair) keeps an older one already kept as the way back.
if [[ -n "$OLD_VERSION" && ("$OLD_VERSION" != "$NEW_VERSION" || ! -f "$PREVIOUS/VERSION") ]]; then
  keep_previous
  marker phase saved
fi
write_settings
write_release_settings
if [[ -n "$OLD_VERSION" ]]; then
  # The app stops first: nothing writes to the database while it's backed up and migrated.
  systemctl stop ilex.service 2>/dev/null || true
  marker phase stopped
fi
install_platform_files
start_platform
backup_database
ensure_app_settings
# Migrated from the new release before it replaces the old: a failure leaves the old one.
migrate_database
marker phase migrated
install_release
# Right away: a run that stops after this is installed as this version — a second run mustn't
# keep these files as the old one.
printf '%s\n' "$NEW_VERSION" | write_file "$ETC/version" root:root 0644
marker phase installed
setup_ssh_login
enable_lingering
start_app
marker phase started
check_setup
print_result
