# system/install/lib/packages.sh — runs as root.
# The programs the platform needs, installed only after asking. Debian and Ubuntu: from their
# makers' signed apt repositories (each key stored in /etc/apt/keyrings and named by `signed-by` —
# trusted for that repository only). Arch: from Arch's own repositories, as the system is — never
# upgraded by us (a full upgrade is the person's decision; a partial one Arch doesn't support).
# Sourced by install.sh.

KEYRINGS=/etc/apt/keyrings
NODE_MIN=24.5.0
SSH_LISTEN_DROPIN=/etc/ssh/sshd_config.d/ilex-listen.conf

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" >/dev/null
}

apt_update() { DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null; }

# Packages from the package database as it is: when it's too old for one to download (or has
# never been read), the person upgrades the system first.
pacman_install() {
  local output
  if ! output="$(pacman -S --needed --noconfirm "$@" 2>&1)"; then
    printf '%s\n' "$output" | tail -n 20 >&2
    die "Could not install $* (pacman's answer above) — if a package could not be downloaded, bring the system up to date first (sudo pacman -Syu), then run this again"
  fi
}

# A repository: its key (downloaded over HTTPS; de-armored if it's ASCII-armored) and its source
# line.
add_repository() {
  local name="$1" key_url="$2" line="$3" key="$KEYRINGS/$1.gpg"
  ensure_dir "$KEYRINGS" root:root 0755
  curl -fsSL --proto '=https' --tlsv1.2 -o "$key.download" "$key_url"
  if grep -q -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' "$key.download"; then
    gpg --dearmor --yes -o "$key.tmp" "$key.download"
    rm -f "$key.download"
  else
    mv -f "$key.download" "$key.tmp"
  fi
  chmod 0644 "$key.tmp"
  mv -f "$key.tmp" "$key"
  printf '%s\n' "${line//@KEY@/$key}" | write_file "/etc/apt/sources.list.d/$name.list" root:root 0644
}

# Nothing (not a failure) when it isn't installed: under `set -e` a failing command
# substitution would end the script without a word.
node_version() { /usr/bin/node --version 2>/dev/null | sed -n 's/^v\([0-9.]*\).*/\1/p' || true; }

ensure_base() {
  log 'Checking the basics'
  local missing=()
  if [[ "$OS_FAMILY" == pacman ]]; then
    for tool in curl openssl sudo visudo; do command -v "$tool" >/dev/null || missing+=("$tool"); done
    [[ -x /usr/bin/kill ]] || missing+=(kill)
    if ((${#missing[@]} > 0)); then
      confirm "Install the basics Ilexarium needs (missing: ${missing[*]})?" || die 'They are needed'
      pacman_install ca-certificates curl openssl sudo util-linux
    fi
    # A person's own systemd and its bus are part of systemd and dbus.
    info 'curl, openssl, sudo, util-linux'
    return
  fi
  # openssl makes the HTTPS certificate.
  for tool in curl gpg openssl sudo visudo; do command -v "$tool" >/dev/null || missing+=("$tool"); done
  # The program, not the shell's builtin: ending a process runs `env kill` as the person.
  [[ -x /usr/bin/kill ]] || missing+=(kill)
  # A person's own systemd and its bus (user units: apps without sudo for the docker group).
  for package in libpam-systemd dbus-user-session; do
    dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'ok installed' ||
      missing+=("$package")
  done
  if ((${#missing[@]} > 0)); then
    confirm "Install the basics Ilexarium needs (missing: ${missing[*]})?" || die 'They are needed'
    apt_update
    apt_install ca-certificates curl gnupg openssl sudo procps libpam-systemd dbus-user-session
  fi
  info 'curl, gnupg, openssl, sudo, procps, libpam-systemd, dbus-user-session'
}

# Node 24.5 or newer (ilex-update trusts the machine's certificates with an API from 24.5) at
# /usr/bin/node — that one, whatever else is on PATH: the root programs' shebang and ilex.service
# name that exact path.
ensure_node() {
  local version
  version="$(node_version)"
  if [[ -n "$version" ]] && version_ge "$version" "$NODE_MIN"; then
    info "Node $(/usr/bin/node --version)"
    return
  fi
  if [[ "$OS_FAMILY" == pacman ]]; then
    confirm "Install Node.js ($NODE_MIN or newer is needed)?" || die "Node.js $NODE_MIN is needed"
    pacman_install nodejs
  else
    confirm "Install Node.js 24 (from NodeSource; $NODE_MIN or newer is needed)?" || die "Node.js $NODE_MIN is needed"
    add_repository nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      'deb [signed-by=@KEY@] https://deb.nodesource.com/node_24.x nodistro main'
    apt_update
    apt_install nodejs
  fi
  version="$(node_version)"
  if [[ -z "$version" ]] || ! version_ge "$version" "$NODE_MIN"; then
    die "Node.js $NODE_MIN could not be installed at /usr/bin/node"
  fi
  info "Node $(/usr/bin/node --version)"
}

# Docker Engine and its Compose plugin (docker.com's packages on Debian and Ubuntu, Arch's own
# on Arch).
ensure_docker() {
  if docker compose version >/dev/null 2>&1; then
    info "$(docker --version)"
    return
  fi
  if [[ "$OS_FAMILY" == pacman ]]; then
    confirm 'Install Docker Engine and Docker Compose?' || die 'Docker is needed'
    pacman_install docker docker-compose
  else
    confirm 'Install Docker Engine and Docker Compose (from docker.com)?' || die 'Docker is needed'
    add_repository docker "https://download.docker.com/linux/$OS_ID/gpg" \
      "deb [arch=$ARCH signed-by=@KEY@] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable"
    apt_update
    apt_install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  systemctl enable --now docker >/dev/null
  info "$(docker --version)"
}

borg_version() {
  local bin
  bin="$(borg_path)" || return 0
  "$bin" --version 2>/dev/null | awk '{ print $2 }' || true
}

# Borg 1.4 or a later 1.x: Borg 2 changed its repositories and commands (ilex-backup is written
# for 1.x).
borg_fits() { [[ -n "$1" ]] && version_ge "$1" 1.4 && ! version_ge "$1" 2; }

# Where people put a Borg they install by hand. An update from the app runs without it on its PATH.
BORG_BY_HAND=/usr/local/bin/borg

# Is file $1 (followed through links) and its folder owned by root and writable by no one else?
root_only() {
  local file
  file="$(readlink -f "$1")" || return 1
  (($(find "$file" "$(dirname "$file")" -maxdepth 0 -user root ! -perm /022 2>/dev/null | wc -l) == 2))
}

# The Borg the platform runs, the same whatever the PATH: one installed by hand in /usr/local/bin
# first (it comes first on a root shell's PATH too), else the one on PATH.
borg_path() {
  if [[ -x "$BORG_BY_HAND" ]] && root_only "$BORG_BY_HAND"; then
    printf '%s\n' "$BORG_BY_HAND"
  else
    command -v borg
  fi
}

# Borg 1.4: Debian 13, Ubuntu 26.04 and Arch have it; Debian 12 from its official backports.
# Ubuntu 24.04 has only Borg 1.2: there the person installs Borg 1.4 first (no package source or
# outside build of ours).
ensure_borg() {
  local version from
  if [[ -e "$BORG_BY_HAND" ]] && ! root_only "$BORG_BY_HAND"; then
    die "$BORG_BY_HAND is not root's own (owned by someone else, or writable by others): fix it or remove it, then run again"
  fi
  version="$(borg_version)"
  if borg_fits "$version"; then
    info "Borg $version"
    return
  fi
  if [[ -n "$version" ]] && version_ge "$version" 2; then
    die "Borg $version is installed: Ilexarium needs Borg 1.4 (Borg 2 is not supported yet)"
  fi
  case "$OS_ID $OS_VERSION" in
    'debian 13') from="Debian's package" ;;
    'debian 12') from="Debian's package from bookworm-backports" ;;
    'ubuntu 26.04') from="Ubuntu's package" ;;
    'ubuntu 24.04')
      die "Ubuntu 24.04 has only Borg ${version:-1.2}: install Borg 1.4 yourself first (https://borgbackup.readthedocs.io/en/1.4-maint/installation.html), in /usr/bin or /usr/local/bin, then run this again"
      ;;
    *) from="Arch's package" ;;
  esac
  confirm "Install Borg 1.4 for backups ($from)?" || die 'Borg 1.4 is needed for backups'
  case "$OS_ID $OS_VERSION" in
    'debian 13' | 'ubuntu 26.04')
      apt_update
      apt_install borgbackup
      ;;
    'debian 12')
      printf 'deb http://deb.debian.org/debian bookworm-backports main\n' |
        write_file /etc/apt/sources.list.d/bookworm-backports.list root:root 0644
      apt_update
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -t bookworm-backports borgbackup >/dev/null
      ;;
    *) pacman_install borg ;;
  esac
  version="$(borg_version)"
  if ! borg_fits "$version"; then
    die "Borg 1.4 could not be installed (have: ${version:-none})"
  fi
  info "Borg $version"
}

# The machine's own SSH server: the Linux sign-in connects to it (as a person, with their password).
# One that runs is the owner's and stays as it is. One the installer installs or turns on listens
# on this machine only (ilex-listen.conf, theirs to remove), as nothing but the sign-in needs it.
ensure_ssh_server() {
  SSH_TURN_ON=0
  SSH_LEFT_OFF=0
  if [[ ! -x /usr/sbin/sshd ]]; then
    confirm 'Install the OpenSSH server for the Linux sign-in, listening on this machine only?' ||
      die 'The OpenSSH server is needed'
    # Before the package: Debian's starts it at once.
    write_ssh_listen
    if [[ "$OS_FAMILY" == pacman ]]; then
      pacman_install openssh
    else
      apt_update
      apt_install openssh-server
    fi
    SSH_TURN_ON=1
  fi
  SSH_UNIT="$(ssh_unit)"
  local socket="${SSH_UNIT%.service}.socket"
  if [[ "$SSH_TURN_ON" == 0 ]] && ssh_switched_off; then
    if [[ "$UPDATE" == 1 ]]; then
      info "The SSH server is switched off and stays off: the Linux sign-in won't work"
      SSH_LEFT_OFF=1
    elif [[ "$(systemctl is-enabled "$SSH_UNIT" 2>/dev/null)" == masked ]]; then
      die "The SSH server is masked ($SSH_UNIT): the Linux sign-in needs it — unmask it yourself, then run again"
    else
      local own
      own="$(ssh_own_listen)"
      confirm "The SSH server is switched off. Turn it on for the Linux sign-in, listening on this machine only${own:+ (and, as your sshd_config says, on $own)}?" ||
        die 'The Linux sign-in needs the SSH server: turn it on yourself, or run again and agree'
      write_ssh_listen
      SSH_TURN_ON=1
    fi
  elif [[ "$SSH_TURN_ON" == 0 ]] && ! systemctl is-enabled --quiet "$SSH_UNIT" 2>/dev/null &&
    ! systemctl is-enabled --quiet "$socket" 2>/dev/null; then
    info "The SSH server runs but doesn't start with the machine: the Linux sign-in stops after a restart (sudo systemctl enable $SSH_UNIT)"
  fi
  info "$(/usr/sbin/sshd -V 2>&1 | head -n1) ($SSH_UNIT)"
}

# Neither its service nor its socket (Ubuntu's way) enabled or running.
ssh_switched_off() {
  local unit
  for unit in "$SSH_UNIT" "${SSH_UNIT%.service}.socket"; do
    if systemctl is-enabled --quiet "$unit" 2>/dev/null || systemctl is-active --quiet "$unit" 2>/dev/null; then
      return 1
    fi
  done
}

# The owner's own ListenAddress lines: sshd listens on every one, ilex-listen.conf's only add to them.
ssh_own_listen() {
  awk -v ours="$SSH_LISTEN_DROPIN" 'FILENAME != ours && tolower($1) == "listenaddress" { print $2 }' \
    /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null |
    sort -u | paste -sd ' ' || true
}

# ::1 only where the machine has it: a socket unit that can't bind an address fails as a whole.
write_ssh_listen() {
  ensure_dir /etc/ssh/sshd_config.d root:root 0755
  {
    printf '%s\n' "# $SSH_LISTEN_DROPIN" \
      '# The SSH server listens on this machine only: Ilexarium installed or turned it on for its' \
      '# Linux sign-in, which connects from here. Remove this file to reach it from other machines.' \
      'ListenAddress 127.0.0.1'
    if grep -qs '^0\{31\}1 ' /proc/net/if_inet6; then printf 'ListenAddress ::1\n'; fi
  } | write_file "$SSH_LISTEN_DROPIN" root:root 0644
  info "$SSH_LISTEN_DROPIN: this machine only"
}

# Its unit: ssh.service on Debian and Ubuntu (sshd.service is only its alias there), sshd.service
# on Arch.
ssh_unit() {
  if [[ -n "$(systemctl list-unit-files --no-legend ssh.service 2>/dev/null)" ]]; then
    printf ssh.service
  else
    printf sshd.service
  fi
}

ensure_packages() {
  ensure_base
  log 'Checking the programs the platform needs'
  ensure_ssh_server
  ensure_node
  ensure_docker
  ensure_borg
}
