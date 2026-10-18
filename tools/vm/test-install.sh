#!/usr/bin/env bash
# Tests the installer end to end on a throwaway machine (docs/plans/installer.md):
# builds a release, installs it (--no-tailscale --yes), runs the smoke test inside, runs the
# installer again (an update) and the smoke test again.
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

echo '==> Building the release'
(cd "$ROOT" && npm run release >"$HERE/run/release.log" 2>&1) || { tail -20 "$HERE/run/release.log"; exit 1; }
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCHIVE="$ROOT/release/homelab-$VERSION.tar.gz"
(cd "$ROOT/release" && sha256sum -c "homelab-$VERSION.tar.gz.sha256" >/dev/null)

if [[ "$MODE" == container ]]; then
  NAME=homelab-install-test
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$NAME-docker" "$NAME-containerd" "$NAME-backup" >/dev/null 2>&1 || true
  echo '==> Starting the test machine (a Debian 13 container with systemd)'
  docker build -q -t homelab-test-machine -f "$HERE/Dockerfile.machine" "$HERE" >/dev/null
  # Privileged with its own cgroup namespace: systemd and Docker inside it. /var/lib/docker and
  # /var/lib/containerd (Docker 29 keeps image layers there) are volumes: overlay can't be nested
  # in the container's own overlay. /mnt/backup another volume — a real mount point on a real
  # filesystem, for the backup.
  docker run -d --name "$NAME" --hostname homelab-test --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock \
    -v "$NAME-docker:/var/lib/docker" -v "$NAME-containerd:/var/lib/containerd" \
    -v "$NAME-backup:/mnt/backup" \
    homelab-test-machine >/dev/null
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

step 'Copying the release in'
copy_in "$ARCHIVE" /root/
copy_in "$ARCHIVE.sha256" /root/
copy_in "$HERE/smoke.mjs" /root/smoke.mjs
run_in bash -c "cd /root && sha256sum -c homelab-$VERSION.tar.gz.sha256 && tar xzf homelab-$VERSION.tar.gz" >>"$LOG" 2>&1

step 'Installing'
if ! run_in bash -c "cd /root/homelab-$VERSION && ./install.sh --yes --no-tailscale" >>"$LOG" 2>&1; then
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

step 'Installing again (update)'
if ! run_in bash -c "cd /root/homelab-$VERSION && ./install.sh --yes --no-tailscale" >>"$LOG" 2>&1; then
  tail -40 "$LOG"
  exit 1
fi
run_in node /root/smoke.mjs update | tee -a "$LOG"
step "Done — log: ${LOG#"$ROOT"/}"
