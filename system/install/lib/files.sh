# system/install/lib/files.sh — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
# The app's user, the release's files, the settings. Sourced by install.sh.

APP_USER=laris
OPT=/opt/laris
ETC=/etc/laris
VAR=/var/lib/laris
PREVIOUS=$OPT/previous

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
  ensure_dir "$VAR/updates" "root:$APP_USER" 0750
  ensure_dir "$VAR/install-backups" root:root 0700
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
# them (the programs' entries check it again before running; a person's sudo runs the root ones
# by path). Only once the database is migrated: until then the old version stays, the way back.
install_release() {
  log 'Installing the release'
  replace_tree "$RELEASE/app" "$OPT/app"
  replace_tree "$RELEASE/catalog" "$OPT/catalog"
  # The root programs and the helper: the whole folder (the release carries no tests or test
  # tools in it), the entries executable.
  local staged
  staged="$(mktemp -d)"
  cp -a "$RELEASE/system/programs/." "$staged/"
  chmod 0755 "$staged"/laris-*.mts
  replace_tree "$staged" "$OPT/libexec"
  rm -rf "$staged"
  install -o root -g root -m 0755 "$RELEASE/system/install/laris-setup-code" /usr/local/bin/laris-setup-code
  info "$OPT"
}

# User units (an app's install or update as the person, with the docker group) need the
# person's systemd to keep running while they're logged out: lingering, for the account that
# installs Laris. Other accounts: `loginctl enable-linger` (or Laris uses system units through
# their sudo).
enable_lingering() {
  local person="${SUDO_USER:-}"
  if [[ -z "$person" || "$person" == root ]]; then
    info 'lingering: no installing account (run with sudo from your account to turn it on)'
    return
  fi
  loginctl enable-linger "$person"
  info "lingering: on for $person"
}

# Where updates come from and the key they're checked with: the release's own, written on every
# install and update (a release built without them can't update itself). laris-update checks a new
# release with the installed key, so a new key only arrives signed by the old one.
write_release_settings() {
  local url=''
  if [[ -f "$RELEASE/release.env" ]]; then url="$(read_setting "$RELEASE/release.env" RELEASE_URL)"; fi
  printf 'RELEASE_URL=%s\n' "$url" | write_file "$ETC/release.env" root:root 0644
  if [[ -n "$url" && -f "$RELEASE/release.pub" ]]; then
    write_file "$ETC/release.pub" root:root 0644 <"$RELEASE/release.pub"
  else
    rm -f "$ETC/release.pub"
  fi
}

# Before an update changes anything: the installed version as it is — the way back
# (laris-update puts it back if the new one doesn't start). The release's folders whole, the
# files it writes elsewhere with their paths; VERSION last, so a kept copy without it is unfinished.
keep_previous() {
  log "Keeping $OLD_VERSION (the way back)"
  local kept="$PREVIOUS.new" dir file
  rm -rf "$kept"
  mkdir -p "$kept/files"
  for dir in app libexec catalog platform; do
    if [[ -d "$OPT/$dir" ]]; then cp -a "$OPT/$dir" "$kept/$dir"; fi
  done
  for file in /etc/systemd/system/laris*.service /etc/systemd/system/laris*.timer \
    "$ETC"/{version,app.env,platform.env,wrappers.json,release.env,release.pub} \
    "$OPT/backup-recovery.md" /etc/tmpfiles.d/laris.conf /etc/ssh/sshd_config.d/laris.conf \
    /usr/local/bin/laris-setup-code; do
    if [[ -f "$file" ]]; then cp -a --parents "$file" "$kept/files/"; fi
  done
  printf '%s\n' "$OLD_VERSION" >"$kept/VERSION"
  chmod 0700 "$kept"
  rm -rf "$PREVIOUS"
  mv "$kept" "$PREVIOUS"
  info "$PREVIOUS"
}

# The platform's own settings: the owner's password and the master key made once and kept; the
# rest worked out from the machine each time (no one's choices). The app's settings are the
# person's: ensure_app_settings.
write_settings() {
  log 'Settings'
  local owner_password docker_gid borg_bin
  owner_password="$(read_setting "$ETC/database.env" POSTGRES_PASSWORD)"
  [[ -n "$owner_password" ]] || owner_password="$(random_hex 24)"
  OWNER_DATABASE_URL="postgresql://laris_owner:$owner_password@127.0.0.1:5432/laris"

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

  borg_bin="$(command -v borg)"
  APP_UID="$APP_UID" APP_GID="$APP_GID" BORG_BIN="$borg_bin" node --input-type=module -e '
    const config = {
      protectedPaths: ["/opt/laris", "/etc/laris", "/var/lib/laris"],
      dockerBin: "/usr/bin/docker",
      disk: { systemctlBin: "/usr/bin/systemctl" },
      update: { appGid: Number(process.env.APP_GID) },
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
    };
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  ' | write_file "$ETC/wrappers.json" root:root 0644

  # The key that encrypts alert channels' secrets: made once, never replaced —
  # a new one would make every stored secret unreadable.
  if [[ ! -s "$ETC/master.key" ]]; then
    head -c 32 /dev/urandom | base64 | write_file "$ETC/master.key" "$APP_USER:$APP_USER" 0400
  fi
  chown "$APP_USER:$APP_USER" "$ETC/master.key"
  chmod 0400 "$ETC/master.key"
  info "$ETC"
}

# The machine's settings for the app (/etc/laris/app.env, read by laris.service): where it listens
# and its database role's password — made with the role at the first install, then the person's.
# An update never changes them; only a database without the role (made again, recovered) gets a
# new password, in DATABASE_URL alone. Needs the database running.
ensure_app_settings() {
  log 'The app’s settings'
  local role password
  role="$(owner_sql -tA <<'SQL'
SELECT count(*) FROM pg_roles WHERE rolname = 'laris';
SQL
)"
  if [[ "$role" == 1 && -f "$ETC/app.env" ]]; then
    owner_sql <<'SQL'
ALTER ROLE laris WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
SQL
    info "$ETC/app.env (kept as it is)"
    return
  fi
  password="$(random_hex 24)"
  owner_sql <<SQL
SELECT 'CREATE ROLE laris LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'laris')
\gexec
ALTER ROLE laris WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$password';
SQL
  if [[ -f "$ETC/app.env" ]]; then
    { grep -v '^DATABASE_URL=' "$ETC/app.env" || true
      printf 'DATABASE_URL=postgresql://laris:%s@127.0.0.1:5432/laris\n' "$password"
    } | write_file "$ETC/app.env" "root:$APP_USER" 0640
    info "$ETC/app.env: a new database password (the database had no role for the app)"
    return
  fi
  write_file "$ETC/app.env" "root:$APP_USER" 0640 <<CONF
HOST=127.0.0.1
PORT=3000
DATABASE_URL=postgresql://laris:$password@127.0.0.1:5432/laris
CONF
  info "$ETC/app.env"
}

# A setting of the app's, as systemd reads it: the last one, spaces around it and one pair of quotes
# taken off. The same rule as laris-update's healthUrlOf (laris-update.spec.ts compares them).
app_setting() {
  local value
  value="$(sed -n "s/^[[:space:]]*$1=//p" "$ETC/app.env" 2>/dev/null | tail -n1 | tr -d '\r')"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
  printf '%s' "$value"
}

# Where the app answers on this machine, from its settings (the app's defaults without them):
# listening on every address, on 127.0.0.1.
app_url() {
  local host port
  host="$(app_setting HOST)"
  port="$(app_setting PORT)"
  case "$host" in
    '' | 0.0.0.0 | ::) host=127.0.0.1 ;;
    *:*) host="[$host]" ;;
  esac
  printf 'http://%s:%s' "$host" "${port:-3000}"
}
