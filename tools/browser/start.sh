#!/usr/bin/env bash
# Starts a separate copy of the app to look at in headless Chromium — never the dev servers or
# the dev database. Server on :3100 (built into run/root, outside the repo), the production web
# build on :4400 (served by serve.mjs, /api proxied), the test database (homelab_test), pretend
# backup disks under run/state/mnt. Usage: ./start.sh [--reset]   (--reset: empty test database,
# fresh state — the next sign-in goes through setup). Stop with ./stop.sh.
set -euo pipefail
T="$(cd "$(dirname "$0")" && pwd)"
P="$(cd "$T/../.." && pwd)"
R="$T/run"
S="$R/state"
mkdir -p "$R"
"$T/stop.sh" >/dev/null 2>&1 || true


# The server, compiled at the same depth as apps/server/dist (it finds catalog/ and system/ by
# relative paths), with links back to the project.
rm -rf "$R/root" && mkdir -p "$R/root/apps/server"
for d in catalog system node_modules; do ln -s "$P/$d" "$R/root/$d"; done
cp "$P/apps/server/package.json" "$R/root/apps/server/"
(cd "$P" && npm run build:shared >/dev/null && npm run prisma:generate -w @homelab/server >/dev/null)
# The test database's schema up to date (only ever homelab_test here — never the dev database).
(cd "$P/apps/server" && DATABASE_URL='postgresql://homelab:homelab-dev@127.0.0.1:5432/homelab_test' npx prisma migrate deploy >/dev/null)
if [[ "${1:-}" == "--reset" ]]; then
  rm -rf "$S"
  # Every table emptied (whatever features added), the migration record kept.
  docker exec homelab-dev-postgres-1 psql -U homelab -d homelab_test -qc "DO \$\$ DECLARE t text; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE', t); END LOOP; END \$\$;"
fi
(cd "$P/apps/server" && npx tsc -p tsconfig.build.json --outDir "$R/root/apps/server/dist")
# The web app, production build (what users get).
rm -rf "$R/web" && (cd "$P/apps/web" && npx ng build --output-path "$R/web" >"$R/web-build.log" 2>&1)

# Pretend backup disks, and the wrappers' config: platform dumps go to the test database.
mkdir -p "$S/srv/docs" "$S/mnt/usb" "$S/mnt/usb2" "$S/backup"
chmod 755 "$T" "$R" "$S"
printf '900 1 0:99 / %s rw - ext4 /dev/sdz1 rw\n901 1 0:98 / %s rw - ext4 /dev/sdy1 rw\n' \
  "$S/mnt/usb" "$S/mnt/usb2" >"$S/backup/mountinfo"
cat >"$S/wrappers.json" <<JSON
{"catalogDir":"$P/catalog","storageRoots":["$S/srv"],"serviceRoot":"$S/srv","reservedPorts":[22,53,2375,3000,3100,4200,4400,5432],"protectedPaths":[],"dockerBin":"/usr/bin/docker","lockFile":"$S/compose.lock","home":"$HOME",
"backup":{"borgBin":"/usr/bin/borg","platform":{"container":"homelab-dev-postgres-1","database":"homelab_test","user":"homelab","files":["$S/wrappers.json"]},
"dev":{"dir":"$S/backup","destinationRoots":["$S/mnt"],"mountInfo":"$S/backup/mountinfo"}}}
JSON

# Detached (own session, no inherited input or output): this script returns once they answer.
(cd "$R/root/apps/server" && NODE_ENV=development PORT=3100 \
  DATABASE_URL='postgresql://homelab:homelab-dev@127.0.0.1:5432/homelab_test' \
  SETUP_TOKEN_FILE="$S/setup-token" MASTER_KEY_FILE="$S/master.key" \
  WRAPPER_CONFIG_FILE="$S/wrappers.json" EXECUTOR_MODE=direct \
  SSH_HOST_KEYS="$P/apps/server/.dev/sshd" \
  setsid node dist/main.js </dev/null >"$R/server.log" 2>&1 & echo $! >"$R/server.pid")
(cd "$T" && setsid node serve.mjs "$R/web/browser" 4400 3100 </dev/null >"$R/serve.log" 2>&1 &
  echo $! >"$R/serve.pid")
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:4400/api/auth/status >/dev/null && break; sleep 1; done
echo "ready: http://localhost:4400 (setup token: $S/setup-token; logs in $R)"
