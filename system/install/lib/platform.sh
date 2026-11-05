# system/install/lib/platform.sh — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
# The platform's containers, the database (two roles, migrations), the app's service.
# Sourced by install.sh.

POSTGRES_CONTAINER=laris-postgres-1

# SQL as the database owner, inside the container (local socket: no password, no network).
# Statements come on stdin — never in arguments, which every user can see in `ps`.
owner_sql() {
  docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -q -X -U laris_owner -d laris "$@"
}

start_platform() {
  log 'Starting the database and the Docker proxy'
  systemctl daemon-reload
  systemctl enable laris-platform.service >/dev/null 2>&1
  systemctl restart laris-platform.service ||
    die 'The platform’s containers did not start (journalctl -u laris-platform)'
  # The proxy has no health check of its own: it's ready once it answers on its socket (an old
  # socket file from before the restart doesn't answer).
  for _ in $(seq 1 30); do
    if curl -sf --unix-socket /run/laris/proxy/docker.sock http://proxy/_ping >/dev/null 2>&1; then
      info "$POSTGRES_CONTAINER, laris-docker-proxy-1"
      return
    fi
    sleep 1
  done
  die 'The Docker proxy doesn’t answer on its socket (docker logs laris-docker-proxy-1)'
}

# An update: the database as it was, before any migration — the way back if one goes wrong.
backup_database() {
  if [[ -z "$OLD_VERSION" ]]; then return; fi
  log 'Backing up the database before the update'
  local dump tmp
  dump="$VAR/install-backups/laris-$OLD_VERSION-$(date +%Y%m%d-%H%M%S).dump"
  tmp="$(mktemp "$VAR/install-backups/.dump.XXXXXX")"
  if ! docker exec "$POSTGRES_CONTAINER" pg_dump -U laris_owner -d laris -Fc >"$tmp" || [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    die 'The database could not be backed up — nothing was changed (the old version is still installed; systemctl start laris)'
  fi
  mv -f "$tmp" "$dump"
  DATABASE_BACKUP="$dump"
  info "$DATABASE_BACKUP"
  marker dump "$DATABASE_BACKUP"
}

# The app's own role may only read and write data: no tables made or dropped, no migrations.
migrate_database() {
  log 'Database'
  # Prisma's migrations, as the owner (only this step ever holds its password) — from the new
  # release, before it replaces anything: if one fails, the old version is still installed.
  if ! (cd "$RELEASE/app/apps/server" &&
    DATABASE_URL="$OWNER_DATABASE_URL" /usr/bin/node ../../node_modules/prisma/build/index.js migrate deploy >/dev/null); then
    if [[ -n "${DATABASE_BACKUP:-}" ]]; then
      die "A migration failed; the old version is still installed. Put the database back first:
    docker exec -i $POSTGRES_CONTAINER pg_restore --clean --if-exists -U laris_owner -d laris <$DATABASE_BACKUP
    then: systemctl start laris"
    fi
    die 'A migration failed'
  fi
  owner_sql <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE laris TO laris;
GRANT USAGE ON SCHEMA public TO laris;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO laris;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO laris;
REVOKE ALL ON TABLE _prisma_migrations FROM laris;
SQL
  info 'migrated; the app’s role reads and writes data only'
}

# Password logins from this machine itself only (the Linux sign-in), in a drop-in checked by
# `sshd -t` before sshd reloads — a refused one is removed again and nothing changes.
setup_ssh_login() {
  log 'SSH: password logins from this machine itself'
  grep -Eqs '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config ||
    die '/etc/ssh/sshd_config does not include /etc/ssh/sshd_config.d/*.conf'
  local dropin=/etc/ssh/sshd_config.d/laris.conf
  ensure_dir /etc/ssh/sshd_config.d root:root 0755
  write_file "$dropin" root:root 0644 <"$RELEASE/system/install/sshd.conf"
  # Arch makes the host keys when sshd first starts: `sshd -t` (and the app, which pins them)
  # needs them now. Only missing ones are made.
  ssh-keygen -A >/dev/null
  if ! /usr/sbin/sshd -t 2>/dev/null; then
    rm -f "$dropin"
    die 'sshd refused the configuration with the drop-in (removed again; nothing changed)'
  fi
  systemctl enable "$SSH_UNIT" >/dev/null 2>&1 || true
  systemctl reload-or-restart "$SSH_UNIT" || die "sshd could not be reloaded (journalctl -u $SSH_UNIT)"
  info "$dropin"
}

start_app() {
  log 'Starting the app'
  systemctl daemon-reload
  systemctl enable laris.service >/dev/null 2>&1
  systemctl restart laris.service

  local url
  url="$(app_url)"
  for _ in $(seq 1 60); do
    if curl -fsS "$url/api/health" >/dev/null 2>&1; then
      info 'the app answers'
      return
    fi
    sleep 1
  done
  die 'The app did not answer within a minute (journalctl -u laris)'
}

print_result() {
  log "Laris $NEW_VERSION is running"
  if [[ -n "${DATABASE_BACKUP:-}" ]]; then info "Database before the update: $DATABASE_BACKUP"; fi
  if [[ "$UPDATE" == 1 ]]; then return; fi
  local url status token
  url="$(app_url)"
  info "It listens on $url. Signing in needs HTTPS: put an HTTPS proxy of your choice in front of it."
  status="$(curl -fsS "$url/api/auth/status" 2>/dev/null || true)"
  if [[ "$status" == *'"needsSetup":true'* ]]; then
    # Read as the app's user: the file is in its folder (root reading it could follow a link).
    token="$(runuser -u "$APP_USER" -- cat "$VAR/app/setup-token" 2>/dev/null || true)"
    info 'Then create your account (the link works once):'
    info ''
    info "    https://<your address>/setup#token=$token"
    info ''
    info 'Lost it? sudo laris-setup-code'
  fi
}
