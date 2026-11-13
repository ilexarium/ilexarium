#!/usr/bin/env bash
# Tests the installer end to end on a throwaway machine: builds a release signed with a test key, serves it over HTTPS inside the
# machine, installs it through get-ilex.sh (--yes; a tampered archive refused first), runs the
# smoke test inside, moves the app to another port (the machine's settings, which updates keep),
# runs the installer again (--update) and the smoke test again, then updates by ilex-update.
#
#   tools/vm/test-install.sh --container   a Debian 13 container with systemd (any machine with
#                                           Docker; privileged — root-equivalent while it runs)
#   tools/vm/test-install.sh --vm           a QEMU VM (tools/vm/vm.sh; a machine with KVM): also
#                                           restarts it and checks everything comes back
#   --os arch                               container mode on Arch Linux instead (the official
#                                           image on x86_64, Arch Linux ARM's root filesystem on
#                                           aarch64)
#   --os ubuntu                             container mode on Ubuntu 24.04 instead
#   --keep                                  leave the machine running afterwards (to look around)
#
# Container mode leaves out what a container can't fake: mounting a real disk and a real restart.
# Output: tools/vm/run/<mode>.log.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MODE=''
OS=debian
KEEP=0
usage() { echo "usage: $0 --container [--os debian|ubuntu|arch]|--vm [--keep]" >&2; exit 2; }
while (($# > 0)); do
  case "$1" in
    --container) MODE=container ;;
    --vm) MODE=vm ;;
    --os) (($# >= 2)) || usage; OS="$2"; shift ;;
    --keep) KEEP=1 ;;
    *) usage ;;
  esac
  shift
done
[[ -n "$MODE" && ("$OS" == debian || "$OS" == ubuntu || "$OS" == arch) ]] || usage
[[ "$OS" == debian || "$MODE" == container ]] || { echo "--os $OS is for --container" >&2; exit 2; }
mkdir -p "$HERE/run"

# Served inside the machine by openssl s_server, with a certificate the machine trusts.
RELEASE_URL=https://localhost:8443/releases
ALARM_ROOTFS=https://fl.us.mirror.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz
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
ARCHIVE="$ROOT/release/ilex-$VERSION.tar.gz"
(cd "$ROOT/release" && sha256sum -c "ilex-$VERSION.tar.gz.sha256" >/dev/null)

if [[ "$MODE" == container ]]; then
  NAME=ilex-install-test
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$NAME-docker" "$NAME-containerd" "$NAME-backup" >/dev/null 2>&1 || true
  if [[ "$OS" == arch ]]; then
    echo '==> Starting the test machine (an Arch Linux container with systemd)'
    base=archlinux:latest
    if [[ "$(uname -m)" == aarch64 ]]; then
      # No official arm64 image: Arch Linux ARM's root filesystem (an HTTPS mirror: their own site
      # has none), checked against its checksum.
      base=ilex-test-alarm
      rootfs="$HERE/run/ArchLinuxARM-aarch64-latest.tar.gz"
      curl -fsSL --proto '=https' -o "$rootfs.md5" "$ALARM_ROOTFS.md5"
      if ! (cd "$HERE/run" && md5sum --quiet -c "$rootfs.md5" 2>/dev/null); then
        curl -fsSL --proto '=https' -o "$rootfs" "$ALARM_ROOTFS"
        (cd "$HERE/run" && md5sum --quiet -c "$rootfs.md5") || { echo 'The root filesystem does not match its checksum' >&2; exit 1; }
      fi
      docker import "$rootfs" "$base" >/dev/null
    fi
    docker build -q -t ilex-test-machine-arch --build-arg "BASE=$base" \
      -f "$HERE/Dockerfile.machine.arch" "$HERE" >/dev/null
    IMAGE=ilex-test-machine-arch
  elif [[ "$OS" == ubuntu ]]; then
    echo '==> Starting the test machine (an Ubuntu 24.04 container with systemd)'
    docker build -q -t ilex-test-machine-ubuntu --build-arg BASE=ubuntu:24.04 \
      -f "$HERE/Dockerfile.machine" "$HERE" >/dev/null
    IMAGE=ilex-test-machine-ubuntu
  else
    echo '==> Starting the test machine (a Debian 13 container with systemd)'
    docker build -q -t ilex-test-machine -f "$HERE/Dockerfile.machine" "$HERE" >/dev/null
    IMAGE=ilex-test-machine
  fi
  # Privileged with its own cgroup namespace: systemd and Docker inside it. /var/lib/docker and
  # /var/lib/containerd (Docker 29 keeps image layers there) are volumes: overlay can't be nested
  # in the container's own overlay. /mnt/backup another volume — a real mount point on a real
  # filesystem, for the backup.
  docker run -d --name "$NAME" --hostname ilex-test --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock \
    -v "$NAME-docker:/var/lib/docker" -v "$NAME-containerd:/var/lib/containerd" \
    -v "$NAME-backup:/mnt/backup" \
    "$IMAGE" >/dev/null
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

# The test's own tools, and a certificate the machine trusts: each system's way.
if [[ "$OS" == arch ]]; then
  install_tools() { run_in pacman -S --needed --noconfirm "$@" >>"$LOG" 2>&1; }
  TRUST='trust anchor --store /srv/tls/cert.pem'
else
  install_tools() { run_in bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" >/dev/null' _ "$@" >>"$LOG" 2>&1; }
  TRUST='cp /srv/tls/cert.pem /usr/local/share/ca-certificates/ilex-test-releases.crt && update-ca-certificates >/dev/null'
  run_in bash -c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq' >>"$LOG" 2>&1
fi

step 'Serving the release over HTTPS'
install_tools curl ca-certificates openssl
run_in mkdir -p /srv/www /srv/tls
copy_in "$RELEASES" /srv/www/releases
run_in bash -c "set -e; TRUST() { $TRUST; }"'
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost -keyout /srv/tls/key.pem -out /srv/tls/cert.pem 2>/dev/null
  TRUST
  systemd-run --unit ilex-test-releases --working-directory=/srv/www \
    openssl s_server -quiet -WWW -accept 8443 -cert /srv/tls/cert.pem -key /srv/tls/key.pem
  for _ in $(seq 1 20); do curl -fsS -o /dev/null https://localhost:8443/releases/latest/download/latest.json && exit 0; sleep 0.5; done
  exit 1' >>"$LOG" 2>&1

step 'Copying the release in'
copy_in "$RELEASES/get-ilex.sh" /root/get-ilex.sh
copy_in "$ARCHIVE" /root/
copy_in "$ARCHIVE.sha256" /root/
copy_in "$HERE/smoke.mjs" /root/smoke.mjs
run_in bash -c "cd /root && sha256sum -c ilex-$VERSION.tar.gz.sha256 && tar xzf ilex-$VERSION.tar.gz" >>"$LOG" 2>&1

step 'get-ilex.sh refuses a tampered archive'
SERVED="/srv/www/releases/download/v$VERSION/ilex-$VERSION.tar.gz"
# One byte changed, size kept (a byte that was already the one written would change nothing).
run_in bash -c "cp $SERVED /root/served.tar.gz &&
  if [[ \$(dd if=$SERVED bs=1 skip=1000 count=1 status=none) == x ]]; then byte=y; else byte=x; fi &&
  printf %s \$byte | dd of=$SERVED bs=1 seek=1000 conv=notrunc status=none &&
  ! cmp -s $SERVED /root/served.tar.gz"
if run_in bash /root/get-ilex.sh --yes >>"$LOG" 2>&1 || run_in test -e /etc/ilex/version; then
  echo 'get-ilex.sh installed a tampered archive' | tee -a "$LOG"
  exit 1
fi
run_in cp /root/served.tar.gz "$SERVED"

step 'Installing (get-ilex.sh)'
if ! run_in bash /root/get-ilex.sh --yes >>"$LOG" 2>&1; then
  tail -40 "$LOG"
  exit 1
fi
# The smoke test's own tools (not the platform's).
install_tools iproute2
# Arch's administrators' group, wheel, may use sudo once sudoers allows it (an administrator's step).
if [[ "$OS" == arch ]]; then
  run_in bash -c "printf '%%wheel ALL=(ALL:ALL) ALL\n' >/etc/sudoers.d/wheel && chmod 0440 /etc/sudoers.d/wheel"
fi

step 'Smoke test'
run_in node /root/smoke.mjs install | tee -a "$LOG"

if [[ "$MODE" == vm ]]; then
  step 'Restarting the machine'
  vm_restart
  run_in node /root/smoke.mjs update | tee -a "$LOG"
fi

# The machine's settings are the person's: on another port, every update must leave them as they
# are (byte for byte) and find the app there.
step 'Moving the app to port 3300 (app.env)'
run_in bash -c "sed -i 's/^PORT=.*/PORT=3300/' /etc/ilex/app.env && systemctl restart ilex &&
  sha256sum /etc/ilex/app.env >/root/app.env.sha256 &&
  for _ in \$(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:3300/api/health && exit 0; sleep 1; done; exit 1" >>"$LOG" 2>&1
app_settings_kept() {
  if ! run_in sha256sum --quiet -c /root/app.env.sha256 >>"$LOG" 2>&1; then
    echo "  FAIL app.env changed by $1" | tee -a "$LOG"
    exit 1
  fi
  echo "  ok   app.env as it was after $1" | tee -a "$LOG"
}

step 'Installing again (--update)'
if ! run_in bash -c "cd /root/ilex-$VERSION && ./install.sh --update" >>"$LOG" 2>&1; then
  tail -40 "$LOG"
  exit 1
fi
app_settings_kept 'install.sh --update'
run_in node /root/smoke.mjs update --installed-again | tee -a "$LOG"

# Two newer versions of the same release, signed with the test key: one that works, one whose app
# never starts (the update must put the working one back).
IFS=. read -r MAJOR MINOR _ <<<"$VERSION"
GOOD="$MAJOR.$((MINOR + 1)).0"
BROKEN="$MAJOR.$((MINOR + 2)).0"
step "Updating to $GOOD, then to a broken $BROKEN (ilex-update)"
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
app_settings_kept "the update to $GOOD"
run_in node /root/smoke.mjs self-update "$BROKEN" rolled_back | tee -a "$LOG"
app_settings_kept "the rolled-back update to $BROKEN"
step "Done — log: ${LOG#"$ROOT"/}"
