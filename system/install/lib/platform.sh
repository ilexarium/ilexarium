# system/install/lib/platform.sh — runs as root.
# The platform's containers, the database (two roles, migrations), the app's service.
# Sourced by install.sh.

POSTGRES_CONTAINER=ilex-postgres-1
DUMPS_KEPT=3

# SQL as the database owner, inside the container (local socket: no password, no network).
# Statements come on stdin — never in arguments, which every user can see in `ps`.
owner_sql() {
  docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -q -X -U ilex_owner -d ilex "$@"
}

start_platform() {
  log 'Starting the database and the Docker proxy'
  systemctl daemon-reload
  systemctl enable ilex-platform.service >/dev/null 2>&1
  # A socket left by a proxy that ran as another uid (uid 99, before the ilex-proxy account):
  # HAProxy hard-links the old socket aside, which Linux allows only its owner, so the new
  # proxy would never start. /run is emptied at boot, so only an update meets one.
  local socket=/run/ilex/proxy/docker.sock
  if [[ -e "$socket" && "$(stat -c %u "$socket")" != "$PROXY_UID" ]]; then rm -f "$socket"; fi
  systemctl restart ilex-platform.service ||
    die 'The platform’s containers did not start (journalctl -u ilex-platform)'
  # The proxy has no health check of its own: it's ready once it answers on its socket (an old
  # socket file from before the restart doesn't answer).
  for _ in $(seq 1 30); do
    if curl -sf --unix-socket /run/ilex/proxy/docker.sock http://proxy/_ping >/dev/null 2>&1; then
      info "$POSTGRES_CONTAINER, ilex-docker-proxy-1"
      return
    fi
    sleep 1
  done
  die 'The Docker proxy doesn’t answer on its socket (docker logs ilex-docker-proxy-1)'
}

# An update: the database as it was, before any migration — the way back if one goes wrong.
backup_database() {
  if [[ -z "$OLD_VERSION" ]]; then return; fi
  log 'Backing up the database before the update'
  local dump tmp
  dump="$VAR/install-backups/ilex-$OLD_VERSION-$(date +%Y%m%d-%H%M%S).dump"
  tmp="$(mktemp "$VAR/install-backups/.dump.XXXXXX")"
  if ! docker exec "$POSTGRES_CONTAINER" pg_dump -U ilex_owner -d ilex -Fc >"$tmp" || [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    die 'The database could not be backed up — nothing was changed (the old version is still installed; systemctl start ilex)'
  fi
  mv -f "$tmp" "$dump"
  DATABASE_BACKUP="$dump"
  prune_dumps "$VAR/install-backups"
  info "$DATABASE_BACKUP"
  marker dump "$DATABASE_BACKUP"
}

# The newest DUMPS_KEPT dumps in folder $1 stay (this update's among them), older ones go.
prune_dumps() {
  local old
  while IFS= read -r old; do rm -f -- "$1/$old"; done < <(
    find "$1" -maxdepth 1 -type f -name 'ilex-*.dump' -printf '%T@ %f\n' |
      sort -rn | tail -n +"$((DUMPS_KEPT + 1))" | cut -d' ' -f2-
  )
}

# The app's own role may only read and write data: no tables made or dropped, no migrations.
migrate_database() {
  log 'Database'
  # Prisma's migrations, as the owner (only this step ever holds its password) — from the new
  # release, before it replaces anything: if one fails, the old version is still installed.
  if ! (cd "$RELEASE/app/apps/server" &&
    DATABASE_URL="$OWNER_DATABASE_URL" /usr/bin/node ../../node_modules/prisma/build/index.js migrate deploy >/dev/null); then
    if [[ -n "${DATABASE_BACKUP:-}" ]]; then
      # Into an empty schema, as ilex-update's rollback does: --clean drops only what the dump
      # holds, and tables of the migrations that did run would stay (the next try fails on them).
      die "A migration failed; the old version is still installed. Put the database back first:
    docker exec $POSTGRES_CONTAINER psql -U ilex_owner -d ilex -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
    docker exec -i $POSTGRES_CONTAINER pg_restore --exit-on-error -U ilex_owner -d ilex <$DATABASE_BACKUP
    then: systemctl start ilex"
    fi
    die 'A migration failed'
  fi
  owner_sql <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE ilex TO ilex;
GRANT USAGE ON SCHEMA public TO ilex;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ilex;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ilex;
REVOKE ALL ON TABLE _prisma_migrations FROM ilex;
SQL
  info 'migrated; the app’s role reads and writes data only'
}

# Password logins from this machine itself only (the Linux sign-in), in a drop-in checked by
# `sshd -t` before sshd reloads — a refused one is removed again and nothing changes.
setup_ssh_login() {
  log 'SSH: password logins from this machine itself'
  grep -Eqs '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config ||
    die '/etc/ssh/sshd_config does not include /etc/ssh/sshd_config.d/*.conf'
  local dropin=/etc/ssh/sshd_config.d/ilex.conf
  ensure_dir /etc/ssh/sshd_config.d root:root 0755
  write_file "$dropin" root:root 0644 <"$RELEASE/system/install/sshd.conf"
  # Arch makes the host keys when sshd first starts: `sshd -t` (and the app, which pins them)
  # needs them now. Only on a machine without any: one an administrator removed stays removed.
  if ! compgen -G '/etc/ssh/ssh_host_*_key' >/dev/null; then ssh-keygen -A >/dev/null || true; fi
  if ! /usr/sbin/sshd -t 2>/dev/null; then
    rm -f "$dropin"
    die 'sshd refused the configuration with the drop-in (removed again; nothing changed)'
  fi
  systemctl enable "$SSH_UNIT" >/dev/null 2>&1 || true
  systemctl reload-or-restart "$SSH_UNIT" || die "sshd could not be reloaded (journalctl -u $SSH_UNIT)"
  info "$dropin"
}

# While an install or update has the app stopped, a request to its port (systemd holds it) mustn't
# start it half-way: ilex.service waits while this file is there — until start_app, or the end of
# this run. ilex-update's rollback holds it the same way.
APP_HOLD=/run/ilex/updating

hold_app() {
  mkdir -p "$(dirname "$APP_HOLD")"
  : >"$APP_HOLD"
  on_exit release_app
}
release_app() { rm -f "$APP_HOLD"; }

# An update that took the port over from an app binding it itself (a version before ilex.socket)
# gives it back if it fails: that version's ilex-update puts it back without knowing the socket.
give_back_port() {
  if [[ "$1" != 0 ]]; then systemctl stop ilex.socket ilex.service 2>/dev/null; fi
}

# The app's own units come with the app, once it's installed: a run that stops before leaves an
# older app with its own unit, runnable as it was.
start_app() {
  log 'Starting the app'
  local units=/etc/systemd/system url address host port
  if [[ -n "$OLD_VERSION" ]] && ! grep -qx 'Sockets=ilex.socket' "$units/ilex.service" 2>/dev/null; then
    on_exit give_back_port
  fi
  install -o root -g root -m 0644 "$RELEASE/system/systemd/ilex.socket" \
    "$RELEASE/system/systemd/ilex.service" "$units/"
  install -D -o root -g root -m 0755 "$RELEASE/system/systemd/ilex-socket-generator" "$SOCKET_GENERATOR"
  systemctl daemon-reload
  systemctl enable ilex.socket ilex.service >/dev/null 2>&1

  url="$(app_url)"
  address="${url#http://}"
  port="${address##*:}"
  host="${address%:*}"
  host="${host#\[}"
  host="${host%\]}"
  # Nothing taking connections there: the socket isn't listening — not started yet, or a
  # daemon-reload after a change to HOST or PORT left it without listeners until it restarts.
  if ! systemctl is-active --quiet ilex.socket || ! listening "$host" "$port"; then
    systemctl restart ilex.socket ||
      die "Port $port ($host) is taken by another program (ss -ltnp shows which): stop it, then run this again"
  fi
  release_app
  systemctl restart ilex.service

  # Each try time-limited: systemd takes the connection even while the app fails to start.
  local end=$((SECONDS + 60))
  while ((SECONDS < end)); do
    if curl -fsS --max-time 3 "$url/api/health" 2>/dev/null | grep -qF "\"version\":\"$NEW_VERSION\""; then
      info "the app answers on $url, ilex.socket holds its port"
      return
    fi
    sleep 1
  done
  die 'The app did not answer within a minute (journalctl -u ilex)'
}

print_result() {
  log "Ilexarium $NEW_VERSION is running"
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
    info 'Lost it? sudo ilex-setup-code'
  fi
}
