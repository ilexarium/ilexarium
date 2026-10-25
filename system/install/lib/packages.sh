# system/install/lib/packages.sh — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
# The programs the platform needs, from their makers' signed apt repositories (each key stored
# in /etc/apt/keyrings and named by `signed-by` — trusted for that repository only), installed
# only after asking. Sourced by install.sh.

KEYRINGS=/etc/apt/keyrings

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" >/dev/null
}

apt_update() { DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null; }

# A repository: its key (downloaded over HTTPS; de-armored if it's ASCII-armored — Tailscale's
# .noarmor.gpg is binary already) and its source line.
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
node_major() { /usr/bin/node --version 2>/dev/null | sed -n 's/^v\([0-9]*\).*/\1/p' || true; }

ensure_base() {
  log 'Checking the basics'
  local missing=()
  for tool in curl gpg sudo visudo; do command -v "$tool" >/dev/null || missing+=("$tool"); done
  # The program, not the shell's builtin: ending a process runs `env kill` as the person.
  [[ -x /usr/bin/kill ]] || missing+=(kill)
  if ((${#missing[@]} > 0)); then
    confirm "Install curl, gnupg, sudo and procps (missing: ${missing[*]})?" || die 'They are needed'
    apt_update
    apt_install ca-certificates curl gnupg sudo procps
  fi
  info 'curl, gnupg, sudo, procps'
}

# Node 24 or newer at /usr/bin/node — that one, whatever else is on PATH: the root wrappers'
# shebang and laris.service name that exact path.
ensure_node() {
  local major
  major="$(node_major)"
  if [[ -n "$major" ]] && ((major >= 24)); then
    info "Node $(/usr/bin/node --version)"
    return
  fi
  confirm 'Install Node.js 24 (from NodeSource)?' || die 'Node.js 24 is needed'
  add_repository nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    'deb [signed-by=@KEY@] https://deb.nodesource.com/node_24.x nodistro main'
  apt_update
  apt_install nodejs
  major="$(node_major)"
  if [[ -z "$major" ]] || ((major < 24)); then die 'Node.js 24 could not be installed at /usr/bin/node'; fi
  info "Node $(/usr/bin/node --version)"
}

# Docker Engine and its Compose plugin (docker.com's packages, not the distribution's).
ensure_docker() {
  if docker compose version >/dev/null 2>&1; then
    info "$(docker --version)"
    return
  fi
  confirm 'Install Docker Engine and Docker Compose (from docker.com)?' || die 'Docker is needed'
  add_repository docker "https://download.docker.com/linux/$OS_ID/gpg" \
    "deb [arch=$ARCH signed-by=@KEY@] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable"
  apt_update
  apt_install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker >/dev/null
  info "$(docker --version)"
}

ensure_tailscale() {
  if [[ "$USE_TAILSCALE" != 1 ]]; then return; fi
  if command -v tailscale >/dev/null; then
    info "Tailscale $(tailscale version | head -n1)"
    return
  fi
  confirm 'Install Tailscale (from tailscale.com)?' || die 'Tailscale is needed for HTTPS (or use --no-tailscale)'
  add_repository tailscale "https://pkgs.tailscale.com/stable/$OS_ID/$OS_CODENAME.noarmor.gpg" \
    "deb [signed-by=@KEY@] https://pkgs.tailscale.com/stable/$OS_ID $OS_CODENAME main"
  apt_update
  apt_install tailscale
  systemctl enable --now tailscaled >/dev/null
  info "Tailscale $(tailscale version | head -n1)"
}

borg_version() { borg --version 2>/dev/null | awk '{ print $2 }' || true; }

# Borg 1.4: Debian 13 has it; Debian 12 from its official backports; Ubuntu 24.04 from the
# Borg maintainers' PPA (costae/borgbackup).
ensure_borg() {
  local version
  version="$(borg_version)"
  if [[ -n "$version" ]] && dpkg --compare-versions "$version" ge 1.4; then
    info "Borg $version"
    return
  fi
  confirm 'Install Borg 1.4 (backups)?' || die 'Borg 1.4 is needed for backups'
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
      apt_update
      apt_install software-properties-common
      add-apt-repository -y ppa:costae/borgbackup >/dev/null
      apt_install borgbackup
      ;;
  esac
  version="$(borg_version)"
  if [[ -z "$version" ]] || ! dpkg --compare-versions "$version" ge 1.4; then
    die "Borg 1.4 could not be installed (have: ${version:-none})"
  fi
  info "Borg $version"
}

# The machine's own SSH server: the Linux sign-in connects to it (as a person, with their password).
ensure_ssh_server() {
  if [[ -x /usr/sbin/sshd ]]; then
    info "$(/usr/sbin/sshd -V 2>&1 | head -n1)"
    return
  fi
  confirm 'Install the OpenSSH server (the Linux sign-in uses it)?' || die 'The OpenSSH server is needed'
  apt_update
  apt_install openssh-server
  info "$(/usr/sbin/sshd -V 2>&1 | head -n1)"
}

ensure_packages() {
  ensure_base
  log 'Checking the programs the platform needs'
  ensure_ssh_server
  ensure_node
  ensure_docker
  ensure_tailscale
  ensure_borg
}
