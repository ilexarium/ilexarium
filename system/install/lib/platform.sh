# system/install/lib/platform.sh — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
# The platform's containers, the database (two roles, migrations), the app's service, HTTPS.
# Sourced by install.sh.

POSTGRES_CONTAINER=homelab-postgres-1

# SQL as the database owner, inside the container (local socket: no password, no network).
# Statements come on stdin — never in arguments, which every user can see in `ps`.
owner_sql() {
  docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -q -X -U homelab_owner -d homelab
}

start_platform() {
  log 'Starting the database and the Docker proxy'
  systemctl daemon-reload
  systemctl enable homelab-platform.service >/dev/null 2>&1
  systemctl restart homelab-platform.service ||
    die 'The platform’s containers did not start (journalctl -u homelab-platform)'
  # The proxy has no health check of its own: it's ready once it answers on its socket (an old
  # socket file from before the restart doesn't answer).
  for _ in $(seq 1 30); do
    if curl -sf --unix-socket /run/homelab/proxy/docker.sock http://proxy/_ping >/dev/null 2>&1; then
      info "$POSTGRES_CONTAINER, homelab-docker-proxy-1"
      return
    fi
    sleep 1
  done
  die 'The Docker proxy doesn’t answer on its socket (docker logs homelab-docker-proxy-1)'
}

# An update: the database as it was, before any migration — the way back if one goes wrong.
backup_database() {
  if [[ -z "$OLD_VERSION" ]]; then return; fi
  log 'Backing up the database before the update'
  local dump tmp
  dump="$VAR/install-backups/homelab-$OLD_VERSION-$(date +%Y%m%d-%H%M%S).dump"
  tmp="$(mktemp "$VAR/install-backups/.dump.XXXXXX")"
  if ! docker exec "$POSTGRES_CONTAINER" pg_dump -U homelab_owner -d homelab -Fc >"$tmp" || [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    die 'The database could not be backed up — nothing was changed (the old version is still installed; systemctl start homelab)'
  fi
  mv -f "$tmp" "$dump"
  DATABASE_BACKUP="$dump"
  info "$DATABASE_BACKUP"
}

# The app's own role may only read and write data: no tables made or dropped, no migrations.
migrate_database() {
  log 'Database'
  owner_sql <<SQL
SELECT 'CREATE ROLE homelab LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'homelab')
\gexec
ALTER ROLE homelab WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$APP_DB_PASSWORD';
SQL
  # Prisma's migrations, as the owner (only this step ever holds its password) — from the new
  # release, before it replaces anything: if one fails, the old version is still installed.
  if ! (cd "$RELEASE/app/apps/server" &&
    DATABASE_URL="$OWNER_DATABASE_URL" /usr/bin/node ../../node_modules/prisma/build/index.js migrate deploy >/dev/null); then
    if [[ -n "${DATABASE_BACKUP:-}" ]]; then
      die "A migration failed; the old version is still installed. Put the database back first:
    docker exec -i $POSTGRES_CONTAINER pg_restore --clean --if-exists -U homelab_owner -d homelab <$DATABASE_BACKUP
    then: systemctl start homelab"
    fi
    die 'A migration failed'
  fi
  owner_sql <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE homelab TO homelab;
GRANT USAGE ON SCHEMA public TO homelab;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO homelab;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO homelab;
REVOKE ALL ON TABLE _prisma_migrations FROM homelab;
SQL
  info 'migrated; the app’s role reads and writes data only'
}

# Password logins from this machine itself only (the Linux sign-in), in a drop-in checked by
# `sshd -t` before sshd reloads — a refused one is removed again and nothing changes.
setup_ssh_login() {
  log 'SSH: password logins from this machine itself'
  grep -Eqs '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config ||
    die '/etc/ssh/sshd_config does not include /etc/ssh/sshd_config.d/*.conf'
  local dropin=/etc/ssh/sshd_config.d/homelab.conf
  ensure_dir /etc/ssh/sshd_config.d root:root 0755
  write_file "$dropin" root:root 0644 <"$RELEASE/system/install/sshd.conf"
  if ! /usr/sbin/sshd -t 2>/dev/null; then
    rm -f "$dropin"
    die 'sshd refused the configuration with the drop-in (removed again; nothing changed)'
  fi
  systemctl enable ssh.service >/dev/null 2>&1 || true
  systemctl reload-or-restart ssh.service || die 'sshd could not be reloaded (journalctl -u ssh)'
  info "$dropin"
}

start_app() {
  log 'Starting the app'
  systemctl daemon-reload
  systemctl enable homelab.service >/dev/null 2>&1
  systemctl restart homelab.service

  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      info 'the app answers'
      return
    fi
    sleep 1
  done
  die 'The app did not answer within a minute (journalctl -u homelab)'
}

# HTTPS in front of the app, through Tailscale (the session cookie needs HTTPS).
setup_https() {
  if [[ "$USE_TAILSCALE" != 1 ]]; then
    PUBLIC_URL='http://localhost:3000'
    warn 'Without Tailscale: the app is reachable only on this machine (http://localhost:3000)'
    return
  fi
  log 'HTTPS (tailscale serve)'
  local state
  state="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(JSON.parse(s).BackendState??"")}catch{}})' || true)"
  [[ "$state" == Running ]] || die 'Tailscale is not signed in: run "sudo tailscale up", then this again'
  tailscale serve --bg --https=443 http://127.0.0.1:3000 >/dev/null ||
    die 'tailscale serve failed (are MagicDNS and HTTPS certificates on in your tailnet?)'
  local name
  name="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')" ||
    die 'Tailscale gave no name for this machine'
  PUBLIC_URL="https://$name"
  info "$PUBLIC_URL"
}

print_result() {
  log "Homelab $NEW_VERSION is running"
  local status token
  status="$(curl -fsS http://127.0.0.1:3000/api/auth/status 2>/dev/null || true)"
  if [[ "$status" == *'"needsSetup":true'* ]]; then
    # Read as the app's user: the file is in its folder (root reading it could follow a link).
    token="$(runuser -u "$APP_USER" -- cat "$VAR/app/setup-token" 2>/dev/null || true)"
    info 'Open this link to create your account (it works once):'
    info ''
    info "    $PUBLIC_URL/setup#token=$token"
    info ''
    info 'Lost it? sudo homelab-setup-code'
  else
    info "Open $PUBLIC_URL"
  fi
  if [[ -n "${DATABASE_BACKUP:-}" ]]; then info "Database before the update: $DATABASE_BACKUP"; fi
}
