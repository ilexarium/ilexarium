#!/usr/bin/env bash
# Tests the installer end to end on a throwaway machine (docs/plans/installer.md,
# install_and_update.md): builds a release signed with a test key, serves it over HTTPS inside the
# machine, installs it through get-laris.sh (--no-tailscale --yes; a tampered archive refused
# first), runs the smoke test inside, runs the installer again (--update) and the smoke test again.
#
#   tools/vm/test-install.sh --container   a Debian 13 container with systemd (any machine with
#                                           Docker; privileged — root-equivalent while it runs)
#   tools/vm/test-install.sh --vm           a QEMU VM (tools/vm/vm.sh; a machine with KVM): also
#                                           restarts it and checks everything comes back
#   --keep                                  leave the machine running afterwards (to look around)
#
# Container mode leaves out what a container can't fake: mounting a real disk and a real restart.
# Output: tools/vm/run/<mode>.log.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MODE=''
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --container) MODE=container ;;
    --vm) MODE=vm ;;
    --keep) KEEP=1 ;;
    *) echo "usage: $0 --container|--vm [--keep]" >&2; exit 2 ;;
  esac
done
[[ -n "$MODE" ]] || { echo "usage: $0 --container|--vm [--keep]" >&2; exit 2; }
mkdir -p "$HERE/run"

# Served inside the machine by openssl s_server, with a certificate the machine trusts.
RELEASE_URL=https://localhost:8443/releases
KEYS="$HERE/run/release-key"
RELEASES="$HERE/run/releases"
export RELEASE_KEY_PASSPHRASE=test-release-key-passphrase

echo '==> Building and signing the release (a test key)'
rm -rf "$KEYS" "$RELEASES"
(
  cd "$ROOT" &&
    npm run release:key -- "$KEYS" &&
    RELEASE_URL="$RELEASE_URL" RELEASE_PUB="$KEYS/release.pub" npm run release &&
    npm run release:sign -- --key "$KEYS/release.key" &&
    npm run release:publish -- "$RELEASES"
) >"$HERE/run/release.log" 2>&1 || { tail -20 "$HERE/run/release.log"; exit 1; }
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCHIVE="$ROOT/release/laris-$VERSION.tar.gz"
(cd "$ROOT/release" && sha256sum -c "laris-$VERSION.tar.gz.sha256" >/dev/null)

if [[ "$MODE" == container ]]; then
  NAME=laris-install-test
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$NAME-docker" "$NAME-containerd" "$NAME-backup" >/dev/null 2>&1 || true
  echo '==> Starting the test machine (a Debian 13 container with systemd)'
  docker build -q -t laris-test-machine -f "$HERE/Dockerfile.machine" "$HERE" >/dev/null
  # Privileged with its own cgroup namespace: systemd and Docker inside it. /var/lib/docker and
  # /var/lib/containerd (Docker 29 keeps image layers there) are volumes: overlay can't be nested
  # in the container's own overlay. /mnt/backup another volume — a real mount point on a real
  # filesystem, for the backup.
  docker run -d --name "$NAME" --hostname laris-test --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock \
    -v "$NAME-docker:/var/lib/docker" -v "$NAME-containerd:/var/lib/containerd" \
    -v "$NAME-backup:/mnt/backup" \
    laris-test-machine >/dev/null
  run_in() { docker exec -i "$NAME" "$@"; }
  copy_in() { docker cp "$1" "$NAME:$2"; }
  cleanup() {
    if [[ "$KEEP" == 1 ]]; then
      echo "==> Left running: docker exec -it $NAME bash   (remove: docker rm -f $NAME; docker volume rm $NAME-docker $NAME-containerd $NAME-backup)"
    else
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker volume rm -f "$NAME-docker" "$NAME-containerd" "$NAME-backup" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup EXIT
  for _ in $(seq 1 30); do
    state="$(run_in systemctl is-system-running 2>/dev/null || true)"
    [[ "$state" == running || "$state" == degraded ]] && break
    sleep 1
  done
else
  # shellcheck source=vm.sh
  . "$HERE/vm.sh"
  vm_start
  trap vm_cleanup EXIT
fi

LOG="$HERE/run/$MODE.log"
: >"$LOG"
step() { echo "==> $*" | tee -a "$LOG"; }

step 'Serving the release over HTTPS'
run_in bash -c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null' >>"$LOG" 2>&1
run_in mkdir -p /srv/www /srv/tls
copy_in "$RELEASES" /srv/www/releases
run_in bash -c '
  set -e
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost -keyout /srv/tls/key.pem -out /srv/tls/cert.pem 2>/dev/null
  cp /srv/tls/cert.pem /usr/local/share/ca-certificates/laris-test-releases.crt
  update-ca-certificates >/dev/null
  systemd-run --unit laris-test-releases --working-directory=/srv/www \
    openssl s_server -quiet -WWW -accept 8443 -cert /srv/tls/cert.pem -key /srv/tls/key.pem
  for _ in $(seq 1 20); do curl -fsS -o /dev/null https://localhost:8443/releases/latest/download/latest.json && exit 0; sleep 0.5; done
  exit 1' >>"$LOG" 2>&1

step 'Copying the release in'
copy_in "$RELEASES/get-laris.sh" /root/get-laris.sh
copy_in "$ARCHIVE" /root/
copy_in "$ARCHIVE.sha256" /root/
copy_in "$HERE/smoke.mjs" /root/smoke.mjs
run_in bash -c "cd /root && sha256sum -c laris-$VERSION.tar.gz.sha256 && tar xzf laris-$VERSION.tar.gz" >>"$LOG" 2>&1

step 'get-laris.sh refuses a tampered archive'
SERVED="/srv/www/releases/download/v$VERSION/laris-$VERSION.tar.gz"
run_in bash -c "cp $SERVED /root/served.tar.gz && printf x | dd of=$SERVED bs=1 seek=1000 conv=notrunc status=none"
if run_in bash /root/get-laris.sh --yes --no-tailscale >>"$LOG" 2>&1 || run_in test -e /etc/laris/version; then
  echo 'get-laris.sh installed a tampered archive' | tee -a "$LOG"
  exit 1
fi
run_in cp /root/served.tar.gz "$SERVED"

step 'Installing (get-laris.sh)'
if ! run_in bash /root/get-laris.sh --yes --no-tailscale >>"$LOG" 2>&1; then
  tail -40 "$LOG"
  exit 1
fi
# The smoke test's own tools (not the platform's).
run_in bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iproute2 >/dev/null' >>"$LOG" 2>&1

step 'Smoke test'
run_in node /root/smoke.mjs install | tee -a "$LOG"

if [[ "$MODE" == vm ]]; then
  step 'Restarting the machine'
  vm_restart
  run_in node /root/smoke.mjs update | tee -a "$LOG"
fi

step 'Installing again (--update)'
if ! run_in bash -c "cd /root/laris-$VERSION && ./install.sh --update" >>"$LOG" 2>&1; then
  tail -40 "$LOG"
  exit 1
fi
run_in node /root/smoke.mjs update --installed-again | tee -a "$LOG"

# Two newer versions of the same release, signed with the test key: one that works, one whose app
# never starts (the update must put the working one back).
IFS=. read -r MAJOR MINOR _ <<<"$VERSION"
GOOD="$MAJOR.$((MINOR + 1)).0"
BROKEN="$MAJOR.$((MINOR + 2)).0"
step "Updating to $GOOD, then to a broken $BROKEN (laris-update)"
(
  cd "$ROOT" &&
    node tools/vm/repack-release.mjs "$ARCHIVE" "$GOOD" &&
    node tools/vm/repack-release.mjs "$ARCHIVE" "$BROKEN" --broken &&
    npm run release:sign -- --key "$KEYS/release.key" --version "$GOOD" &&
    npm run release:publish -- "$RELEASES" "$GOOD" &&
    npm run release:sign -- --key "$KEYS/release.key" --version "$BROKEN" &&
    npm run release:publish -- "$RELEASES" "$BROKEN"
) >>"$HERE/run/release.log" 2>&1 || { tail -20 "$HERE/run/release.log"; exit 1; }
run_in rm -rf /srv/www/releases
copy_in "$RELEASES" /srv/www/releases
run_in node /root/smoke.mjs self-update "$GOOD" updated | tee -a "$LOG"
run_in node /root/smoke.mjs self-update "$BROKEN" rolled_back | tee -a "$LOG"
step "Done — log: ${LOG#"$ROOT"/}"
