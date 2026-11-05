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
  OS_FAMILY="$(os_family "$OS_ID" "$OS_VERSION" "$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")")"
  [[ -n "$OS_FAMILY" ]] ||
    die "Supported: Debian 12 and 13, Ubuntu 24.04, Arch Linux — this is $OS_ID $OS_VERSION"
  ARCH="$(cpu_arch "$(uname -m)")"
  [[ -n "$ARCH" ]] || die "Supported: amd64 and arm64 — this machine is $(uname -m)"
  local free_mb
  free_mb="$(df -Pm /opt | awk 'NR == 2 { print $4 }')"
  ((free_mb >= MIN_FREE_MB)) || die "At least ${MIN_FREE_MB} MB free on /opt needed (${free_mb} MB)"
  if [[ "$OS_FAMILY" == pacman ]]; then info "$OS_ID, $ARCH"; else info "$OS_ID $OS_VERSION ($OS_CODENAME), $ARCH"; fi
}

# How a supported system installs packages (apt, pacman), from os-release's ID, VERSION_ID and
# ID_LIKE; nothing for any other. Arch is rolling: no version.
os_family() {
  case "$1 $2" in
    'debian 12' | 'debian 13' | 'ubuntu 24.04') printf apt ;;
    *) if [[ "$1" == arch || "$1" == archarm || " $3 " == *' arch '* ]]; then printf pacman; fi ;;
  esac
}

# The CPU as Debian names it (Docker's repository too), from `uname -m`; nothing for any other.
cpu_arch() {
  case "$1" in
    x86_64) printf amd64 ;;
    aarch64) printf arm64 ;;
  esac
}

# Is version $1 at least $2 (1.4.0 ≥ 1.4; 2.0.0b1 ≥ 2)?
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

# A first install, or an update of an older one — never back to an older version.
check_version() {
  NEW_VERSION="$(cat "$RELEASE/VERSION")"
  OLD_VERSION=''
  if [[ -f /etc/laris/version ]]; then OLD_VERSION="$(cat /etc/laris/version)"; fi
  if [[ -z "$OLD_VERSION" && "$UPDATE" == 1 ]]; then
    die '--update is for an installed Laris'
  elif [[ -z "$OLD_VERSION" ]]; then
    info "Installing $NEW_VERSION"
  elif ! version_ge "$NEW_VERSION" "$OLD_VERSION"; then
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

# After the install: is the installing account set up the way Laris acts as it
# (docs/plans/machine_check.md)? Not fatal — each problem with what to do; Laris → Settings →
# Machine check checks again, as the person.
check_setup() {
  log 'Checking the setup for your account'
  local person="${SUDO_USER:-}"
  if [[ -z "$person" || "$person" == root ]]; then
    info 'skipped: these checks need an installing account (run with sudo from your account)'
    return
  fi
  local problems=0 effective sudo_rights
  # Read whole first: `grep -q` stops at its match, and the program it reads from then fails
  # (SIGPIPE) — a failed pipeline under pipefail.
  effective="$(/usr/sbin/sshd -T -C "user=$person,host=localhost,addr=127.0.0.1" 2>/dev/null || true)"
  sudo_rights="$(sudo -l -U "$person" 2>/dev/null || true)"

  # Keys in lowercase before OpenSSH 10.6, as sshd_config writes them since.
  if grep -qix 'passwordauthentication yes' <<<"$effective"; then
    info "✓ password logins from this machine, for $person"
  else
    problems=$((problems + 1))
    # A global "no" never wins over laris.conf's Match block: only a Match block read before it
    # does — a drop-in sorted earlier (the main file includes them at its top).
    local turned_off
    turned_off="$(awk 'FNR == 1 { in_match = 0 }
      tolower($1) == "match" { in_match = 1 }
      in_match && tolower($1) == "passwordauthentication" && tolower($2) == "no" { print FILENAME }' \
      /etc/ssh/sshd_config.d/*.conf 2>/dev/null | grep -vx /etc/ssh/sshd_config.d/laris.conf | sort -u | paste -sd ' ' || true)"
    info "✗ password logins from this machine are off for $person: the Linux sign-in won't work"
    if [[ -n "$turned_off" ]]; then
      info "  look in: $turned_off — a setting there turns them off; then: sudo systemctl reload $SSH_UNIT"
    else
      info "  see why: sudo sshd -T -C user=$person,host=localhost,addr=127.0.0.1 | grep -i password"
    fi
  fi

  if grep -qE '^\s*\((ALL|root)(\s*:\s*\S+)?\)' <<<"$sudo_rights"; then
    info "✓ $person may use sudo"
  else
    problems=$((problems + 1))
    info "✗ $person may not use sudo: no administrator tasks (backups, disks, services)"
    if [[ "$OS_FAMILY" == pacman ]]; then
      info "  fix: sudo usermod -aG wheel $person, allow the wheel group (sudo visudo: the %wheel ALL=(ALL:ALL) ALL line), then sign in again"
    else
      info "  fix: sudo usermod -aG sudo $person (then sign in again)"
    fi
  fi

  # Lingering keeps a user unit running once the person's sessions end (an app's install after
  # the Linux sign-in closed). systemd-run below starts the user manager itself: it can't tell.
  if [[ -e "/var/lib/systemd/linger/$person" ]]; then
    info "✓ lingering on for $person"
  else
    problems=$((problems + 1))
    info "✗ lingering is off for $person: app tasks would stop with the Linux sign-in"
    info "  fix: sudo loginctl enable-linger $person"
  fi
  if timeout 30 systemd-run --user --machine="$person@" --wait --quiet --collect true >/dev/null 2>&1; then
    info "✓ user units start for $person"
  else
    problems=$((problems + 1))
    info "✗ user units don't start for $person: app tasks will need sudo"
    if [[ "$OS_FAMILY" == apt ]]; then info '  fix: install libpam-systemd and dbus-user-session'; fi
    info "  see why: systemctl status user@$(id -u "$person").service"
  fi

  if ((problems > 0)); then info 'Fix these, then check again:'; fi
  info 'Laris → Settings → Machine check checks again, as you (running this installer again does too)'
}
