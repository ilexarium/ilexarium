# system/install/lib/packages.sh — runs as root.
# The programs the platform needs, installed only after asking. Debian and Ubuntu: from their
# makers' signed apt repositories (each key stored in /etc/apt/keyrings and named by `signed-by` —
# trusted for that repository only), except Borg on Ubuntu (see BORG_RELEASE). Arch: from Arch's
# own repositories, as the system is — never upgraded by us (a full upgrade is the person's
# decision; a partial one Arch doesn't support).
# Sourced by install.sh.

KEYRINGS=/etc/apt/keyrings
NODE_MIN=24.5.0

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
    for tool in curl sudo visudo; do command -v "$tool" >/dev/null || missing+=("$tool"); done
    [[ -x /usr/bin/kill ]] || missing+=(kill)
    if ((${#missing[@]} > 0)); then
      confirm "Install the basics Ilexarium needs (missing: ${missing[*]})?" || die 'They are needed'
      pacman_install ca-certificates curl sudo util-linux
    fi
    # A person's own systemd and its bus are part of systemd and dbus.
    info 'curl, sudo, util-linux'
    return
  fi
  for tool in curl gpg sudo visudo; do command -v "$tool" >/dev/null || missing+=("$tool"); done
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
    apt_install ca-certificates curl gnupg sudo procps libpam-systemd dbus-user-session
  fi
  info 'curl, gnupg, sudo, procps, libpam-systemd, dbus-user-session'
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

borg_version() { borg --version 2>/dev/null | awk '{ print $2 }' || true; }

# Borg 1.4 or a later 1.x: Borg 2 changed its repositories and commands (ilex-backup is written
# for 1.x).
borg_fits() { [[ -n "$1" ]] && version_ge "$1" 1.4 && ! version_ge "$1" 2; }

# Ubuntu 24.04 has only Borg 1.2: the Borg project's own build instead, one exact file per CPU
# from its GitHub release, trusted by the SHA-256 written here (no package source is added). The
# amd64 build is signed by Borg's maintainer; the arm64 one, the project's only arm64 build, comes
# from its GitHub workflow with a provenance attestation. A new version here: check both again.
BORG_RELEASE=1.4.5
BORG_URL="https://github.com/borgbackup/borg/releases/download/$BORG_RELEASE"
BORG_HOME=/usr/local/lib/borg
BORG_LINK=/usr/local/bin/borg

# The build for CPU $1: its file name and SHA-256; nothing for any other CPU.
borg_build() {
  case "$1" in
    amd64) printf '%s %s' borg-linux-glibc231-x86_64.tgz b6cba6b5eee19d51fbf4d89c6090dd40647b856755fffe2e26417365536f2c58 ;;
    arm64) printf '%s %s' borg-linux-glibc235-arm64-gh.tgz 579d977d4eafd5761aee51e4a5bd3c52a5533a4391393d465324f675d14d3bd9 ;;
  esac
}

# Downloads build $1, refuses it unless its SHA-256 is $2, and installs it root-owned in
# $BORG_HOME, linked as $BORG_LINK. The single-folder build: the single-file one unpacks itself
# into /tmp on every run, which fails where /tmp is mounted noexec.
install_borg_build() {
  local file="$1" sum="$2" tmp
  tmp="$(mktemp -d)"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/$file" "$BORG_URL/$file"
  if ! printf '%s  %s\n' "$sum" "$tmp/$file" | sha256sum --check --status; then
    rm -rf "$tmp"
    die "The downloaded $file is not the Borg $BORG_RELEASE build this installer knows (its SHA-256 differs): nothing was installed"
  fi
  tar -xzf "$tmp/$file" -C "$tmp" --no-same-owner
  replace_tree "$tmp/borg-dir" "$BORG_HOME"
  ln -sfn "$BORG_HOME/borg.exe" "$BORG_LINK"
  rm -rf "$tmp"
}

# Borg 1.4: Debian 13 and Arch have it; Debian 12 from its official backports; Ubuntu 24.04 the
# Borg project's own build (above).
ensure_borg() {
  local version from file sum
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
    'ubuntu 24.04') from="the Borg project's own build $BORG_RELEASE from github.com/borgbackup/borg, checked against the SHA-256 in this installer" ;;
    *) from="Arch's package" ;;
  esac
  confirm "Install Borg 1.4 for backups ($from)?" || die 'Borg 1.4 is needed for backups'
  case "$OS_ID $OS_VERSION" in
    'debian 13')
      apt_update
      apt_install borgbackup
      ;;
    'debian 12')
      printf 'deb http://deb.debian.org/debian bookworm-backports main\n' |
        write_file /etc/apt/sources.list.d/bookworm-backports.list root:root 0644
      apt_update
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -t bookworm-backports borgbackup >/dev/null
      ;;
    'ubuntu 24.04')
      read -r file sum <<<"$(borg_build "$ARCH")"
      install_borg_build "$file" "$sum"
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
ensure_ssh_server() {
  if [[ ! -x /usr/sbin/sshd ]]; then
    confirm 'Install the OpenSSH server (the Linux sign-in uses it)?' || die 'The OpenSSH server is needed'
    if [[ "$OS_FAMILY" == pacman ]]; then
      pacman_install openssh
    else
      apt_update
      apt_install openssh-server
    fi
  fi
  SSH_UNIT="$(ssh_unit)"
  info "$(/usr/sbin/sshd -V 2>&1 | head -n1) ($SSH_UNIT)"
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
