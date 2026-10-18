# system/install/lib/checks.sh — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
# What this machine must be before anything is changed. Sourced by install.sh.

MIN_FREE_MB=4096

check_machine() {
  log 'Checking this machine'
  [[ "$(id -u)" == 0 ]] || die 'Run it as root: sudo ./install.sh'
  [[ -d /run/systemd/system ]] || die 'systemd is needed (this machine runs without it)'
  [[ -r /etc/os-release ]] || die 'Unknown system (no /etc/os-release)'
  OS_ID="$(. /etc/os-release && printf '%s' "$ID")"
  OS_VERSION="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  OS_CODENAME="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
  case "$OS_ID $OS_VERSION" in
    'debian 12' | 'debian 13' | 'ubuntu 24.04') ;;
    *) die "Supported: Debian 12 and 13, Ubuntu 24.04 — this is $OS_ID $OS_VERSION" ;;
  esac
  ARCH="$(dpkg --print-architecture)"
  case "$ARCH" in
    amd64 | arm64) ;;
    *) die "Supported: amd64 and arm64 — this machine is $ARCH" ;;
  esac
  local free_mb
  free_mb="$(df -Pm /opt | awk 'NR == 2 { print $4 }')"
  ((free_mb >= MIN_FREE_MB)) || die "At least ${MIN_FREE_MB} MB free on /opt needed (${free_mb} MB)"
  info "$OS_ID $OS_VERSION ($OS_CODENAME), $ARCH"
}

# A first install, or an update of an older one — never back to an older version.
check_version() {
  NEW_VERSION="$(cat "$RELEASE/VERSION")"
  OLD_VERSION=''
  if [[ -f /etc/homelab/version ]]; then OLD_VERSION="$(cat /etc/homelab/version)"; fi
  if [[ -z "$OLD_VERSION" ]]; then
    info "Installing $NEW_VERSION"
  elif dpkg --compare-versions "$NEW_VERSION" lt "$OLD_VERSION"; then
    die "$OLD_VERSION is installed; this is the older $NEW_VERSION — going back isn't supported"
  else
    info "Updating $OLD_VERSION to $NEW_VERSION"
  fi
}

# The app's user must not reach Docker's socket: only the proxy may (docs/plans/monitoring_dashboard.md).
check_not_in_docker_group() {
  if id -nG "$APP_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    die "$APP_USER is in the docker group (root-equivalent): remove it (gpasswd -d $APP_USER docker) and run this again"
  fi
}
