# system/install/lib/files.sh — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
# The app's user, the release's files, the settings. Sourced by install.sh.

APP_USER=laris
OPT=/opt/laris
ETC=/etc/laris
VAR=/var/lib/laris
SRV=/srv/laris

# A system user without a login shell. Its home, the only folder it may write, is
# /var/lib/laris/app: /var/lib/laris itself is root's, so the app can't swap the backups'
# state folder (written as root) for something else.
ensure_user() {
  log 'The app’s user'
  if ! getent group "$APP_USER" >/dev/null; then groupadd --system "$APP_USER"; fi
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd --system --gid "$APP_USER" --home-dir "$VAR/app" --no-create-home \
      --shell /usr/sbin/nologin --comment 'Laris platform' "$APP_USER"
  fi
  check_not_in_docker_group
  APP_UID="$(id -u "$APP_USER")"
  APP_GID="$(id -g "$APP_USER")"
  info "$APP_USER (uid $APP_UID)"
}

ensure_folders() {
  ensure_dir "$OPT" root:root 0755
  ensure_dir "$ETC" root:root 0755
  ensure_dir "$VAR" root:root 0755
  ensure_dir "$VAR/app" "$APP_USER:$APP_USER" 0700
  ensure_dir "$VAR/backups" "root:$APP_USER" 0750
  ensure_dir "$VAR/install-backups" root:root 0700
  ensure_dir "$SRV" root:root 0755
  ensure_dir "$SRV/restores" root:root 0755
}

# The platform's own files — needed before the database starts: its compose file and the
# proxy's config, the units, the /run/laris folders.
install_platform_files() {
  log 'The platform’s files'
  ensure_dir "$OPT/platform" root:root 0755
  install -o root -g root -m 0644 "$RELEASE/system/platform/compose.yml" "$OPT/platform/compose.yml"
  install -o root -g root -m 0644 "$RELEASE/system/docker-socket-proxy/haproxy.cfg" "$OPT/platform/haproxy.cfg"
  install -o root -g root -m 0644 "$RELEASE/system/backup-recovery.md" "$OPT/backup-recovery.md"
  for unit in "$RELEASE"/system/systemd/*.service "$RELEASE"/system/systemd/*.timer; do
    install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
  done
  install -o root -g root -m 0644 "$RELEASE/system/install/tmpfiles.conf" /etc/tmpfiles.d/laris.conf
  systemd-tmpfiles --create /etc/tmpfiles.d/laris.conf
  info "$OPT/platform, the units"
}

# The release's programs: root-owned, writable only by root — the app reads them, never changes
# them (the wrappers' entries check it again before running, sudo trusts their paths). Only once
# the database is migrated: until then the old version stays, the way back.
install_release() {
  log 'Installing the release'
  replace_tree "$RELEASE/app" "$OPT/app"
  replace_tree "$RELEASE/catalog" "$OPT/catalog"
  # The wrappers: the whole folder (the release carries no tests or test tools in it), the
  # entries executable.
  local staged
  staged="$(mktemp -d)"
  cp -a "$RELEASE/system/wrappers/." "$staged/"
  chmod 0755 "$staged"/laris-*.mts
  replace_tree "$staged" "$OPT/libexec"
  rm -rf "$staged"
  install -o root -g root -m 0755 "$RELEASE/system/install/laris-setup-code" /usr/local/bin/laris-setup-code
  install_sudoers
  info "$OPT"
}

# The four wrapper lines — only once visudo accepts the file: a broken sudoers file can lock
# everyone out of sudo. The temporary file is beside the real one (one atomic rename, never a
# half-copied file across filesystems) and named with a dot, which sudo ignores in sudoers.d.
install_sudoers() {
  local tmp
  tmp="$(mktemp /etc/sudoers.d/.laris.XXXXXX)"
  cp "$RELEASE/system/sudoers/laris" "$tmp"
  chmod 0440 "$tmp"
  visudo -cqf "$tmp" || {
    rm -f "$tmp"
    die 'The sudoers file was refused by visudo (nothing changed)'
  }
  chown root:root "$tmp"
  mv -f "$tmp" /etc/sudoers.d/laris
  info 'sudoers: the four wrappers'
}

# Settings: passwords and the master key made once and kept; everything else written each time.
write_settings() {
  log 'Settings'
  local owner_password app_password docker_gid borg_bin trust_proxy
  owner_password="$(read_setting "$ETC/database.env" POSTGRES_PASSWORD)"
  [[ -n "$owner_password" ]] || owner_password="$(random_hex 24)"
  app_password="$(read_setting "$ETC/app.env" DATABASE_URL | sed -n 's|^postgresql://laris:\([0-9a-f]*\)@.*|\1|p' || true)"
  [[ -n "$app_password" ]] || app_password="$(random_hex 24)"
  OWNER_DATABASE_URL="postgresql://laris_owner:$owner_password@127.0.0.1:5432/laris"
  APP_DB_PASSWORD="$app_password"

  write_file "$ETC/database.env" root:root 0600 <<CONF
POSTGRES_USER=laris_owner
POSTGRES_PASSWORD=$owner_password
POSTGRES_DB=laris
CONF

  docker_gid="$(getent group docker | cut -d: -f3 || true)"
  [[ -n "$docker_gid" ]] || die 'No docker group (is Docker installed?)'
  write_file "$ETC/platform.env" root:root 0644 <<CONF
DOCKER_GID=$docker_gid
CONF

  trust_proxy=false
  if [[ "$USE_TAILSCALE" == 1 ]]; then trust_proxy=loopback; fi
  write_file "$ETC/app.env" "root:$APP_USER" 0640 <<CONF
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
DATABASE_URL=postgresql://laris:$app_password@127.0.0.1:5432/laris
DOCKER_HOST=unix:///run/laris/proxy/docker.sock
TRUST_PROXY=$trust_proxy
WEB_ROOT=$OPT/app/apps/web/browser
SETUP_TOKEN_FILE=$VAR/app/setup-token
CONF

  borg_bin="$(command -v borg)"
  APP_UID="$APP_UID" APP_GID="$APP_GID" BORG_BIN="$borg_bin" node --input-type=module -e '
    const config = {
      catalogDir: "/opt/laris/catalog",
      storageRoots: ["/srv/laris"],
      serviceRoot: "/srv/laris",
      reservedPorts: [22, 53, 2375, 3000, 5432, 41641],
      protectedPaths: ["/opt/laris", "/etc/laris", "/var/lib/laris", "/srv/laris/restores"],
      dockerBin: "/usr/bin/docker",
      disk: { systemctlBin: "/usr/bin/systemctl" },
      backup: {
        borgBin: process.env.BORG_BIN,
        systemctlBin: "/usr/bin/systemctl",
        appUid: Number(process.env.APP_UID),
        appGid: Number(process.env.APP_GID),
        platform: {
          container: "laris-postgres-1",
          database: "laris",
          user: "laris_owner",
          files: [
            "/etc/laris/master.key",
            "/etc/laris/wrappers.json",
            "/etc/laris/backup.json",
            "/etc/laris/backup-repository.json",
            "/etc/systemd/system/laris-backup.timer.d/schedule.conf",
          ],
        },
      },
      process: { appUid: Number(process.env.APP_UID) },
    };
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  ' | write_file "$ETC/wrappers.json" root:root 0644

  # The key that encrypts services' and alert channels' secrets: made once, never replaced —
  # a new one would make every stored secret unreadable.
  if [[ ! -s "$ETC/master.key" ]]; then
    head -c 32 /dev/urandom | base64 | write_file "$ETC/master.key" "$APP_USER:$APP_USER" 0400
  fi
  chown "$APP_USER:$APP_USER" "$ETC/master.key"
  chmod 0400 "$ETC/master.key"
  info "$ETC"
}
