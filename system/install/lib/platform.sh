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
  [[ -S /run/homelab/proxy/docker.sock ]] || die 'The Docker proxy’s socket is missing'
  info "$POSTGRES_CONTAINER, homelab-docker-proxy-1"
}

# An update: the database as it was, before any migration — the way back if one goes wrong.
backup_database() {
  if [[ -z "$OLD_VERSION" ]]; then return; fi
  log 'Backing up the database before the update'
  DATABASE_BACKUP="$VAR/install-backups/homelab-$OLD_VERSION-$(date +%Y%m%d-%H%M%S).dump"
  docker exec "$POSTGRES_CONTAINER" pg_dump -U homelab_owner -d homelab -Fc |
    write_file "$DATABASE_BACKUP" root:root 0600
  [[ -s "$DATABASE_BACKUP" ]] || die 'The database backup is empty (nothing was changed)'
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
  # Prisma's migrations, as the owner (only this step ever holds its password).
  if ! (cd "$OPT/app/apps/server" &&
    DATABASE_URL="$OWNER_DATABASE_URL" node ../../node_modules/prisma/build/index.js migrate deploy >/dev/null); then
    if [[ -n "${DATABASE_BACKUP:-}" ]]; then
      die "A migration failed. The database before the update: $DATABASE_BACKUP (pg_restore --clean)"
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
    token="$(cat "$VAR/app/setup-token" 2>/dev/null || true)"
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
