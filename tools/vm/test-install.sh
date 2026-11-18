#!/usr/bin/env bash
# Tests the installer end to end on a throwaway machine: builds a release signed with a test key, serves it over HTTPS inside the
# machine, installs it through get-ilex.sh (--yes; a tampered archive and a port another program answers on refused first), runs the
# smoke test inside, moves the app to another port (the machine's settings, which updates keep),
# runs the installer again (--update) and the smoke test again, then updates by ilex-update.
#
#   tools/vm/test-install.sh --container   a Debian 13 container with systemd (any machine with
#                                           Docker; privileged — root-equivalent while it runs,
#                                           so it asks first)
#   tools/vm/test-install.sh --vm           a QEMU VM (tools/vm/vm.sh; a machine with KVM): also
#                                           restarts it and checks everything comes back
#   tools/vm/test-install.sh --clean        remove what earlier runs left: the test machines,
#                                           their volumes and images, tools/vm/run
#   --yes                                   don't ask before starting a privileged container
#   --os arch                               container mode on Arch Linux instead (the official
#                                           image on x86_64, Arch Linux ARM's root filesystem on
#                                           aarch64, Apple silicon included)
#   --os ubuntu                             container mode on Ubuntu 26.04 instead
#   --keep                                  leave the machine running afterwards (to look around)
#   --from <version>|<archive>|none         container mode: also install that older release (by
#                                           default the one in tools/vm/oldest-release, the first
#                                           public one), run its own smoke test (from its git tag;
#                                           with an archive, this tree's), then update it by
#                                           ilex-update straight to this release and check again —
#                                           every release must update from every older one
#
# Container mode leaves out what a container can't fake: mounting a real disk and a real restart.
# Output: tools/vm/run/<mode>.log.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MODE=''
OS=debian
KEEP=0
YES=0
FROM=''
OLDEST_URL=https://ilexarium.com/releases
usage() { echo "usage: $0 --container [--os debian|ubuntu|arch] [--from <version>|<archive>|none] [--yes]|--vm [--keep]|--clean" >&2; exit 2; }
while (($# > 0)); do
  case "$1" in
    --container) MODE=container ;;
    --vm) MODE=vm ;;
    --clean) MODE=clean ;;
    --yes) YES=1 ;;
    --os) (($# >= 2)) || usage; OS="$2"; shift ;;
    --keep) KEEP=1 ;;
    --from) (($# >= 2)) || usage; FROM="$2"; shift ;;
    *) usage ;;
  esac
  shift
done
[[ -n "$MODE" && ("$OS" == debian || "$OS" == ubuntu || "$OS" == arch) ]] || usage
[[ "$OS" == debian || "$MODE" == container ]] || { echo "--os $OS is for --container" >&2; exit 2; }
[[ -n "$FROM" ]] || FROM="$(tr -d '[:space:]' <"$HERE/oldest-release" 2>/dev/null || true)"
[[ "$FROM" == none ]] && FROM=''

# One run at a time: runs share tools/vm/run, release/ and the machines' names.
mkdir -p "$HERE/run"
LOCK="$HERE/run/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [[ "$holder" =~ ^[0-9]+$ ]] && ((holder > 1)) && kill -0 "$holder" 2>/dev/null; then
    echo "An install test is already running here (pid $holder): one at a time." >&2
    exit 1
  fi
  rm -rf "$LOCK" && mkdir "$LOCK"
fi
echo $$ >"$LOCK/pid"
release_lock() { rm -rf "$LOCK"; }
trap release_lock EXIT

if [[ "$MODE" == clean ]]; then
  for machine in ilex-install-test ilex-install-test-from; do
    docker rm -f "$machine" >/dev/null 2>&1 || true
    docker volume rm -f "$machine-docker" "$machine-containerd" "$machine-backup" >/dev/null 2>&1 || true
  done
  docker image rm -f ilex-test-machine ilex-test-machine-ubuntu ilex-test-machine-arch ilex-test-alarm >/dev/null 2>&1 || true
  find "$HERE/run" -mindepth 1 -maxdepth 1 ! -name lock -exec rm -rf {} +
  echo '==> Removed the test machines, their volumes and images, and tools/vm/run'
  exit 0
fi

if [[ "$MODE" == container && "$YES" != 1 ]]; then
  cat >&2 <<'EOF'
The install test runs Ilexarium's installer in a privileged Docker container: it can reach this
machine's devices and kernel, as root can. Nothing in the test does, but it isn't a sandbox.
For full isolation use --vm (a machine with KVM). Afterwards: tools/vm/test-install.sh --clean.
EOF
  if [[ ! -t 0 ]]; then
    echo 'No one to ask: pass --yes to start it.' >&2
    exit 2
  fi
  read -r -p 'Start it? [y/N] ' answer
  [[ "$answer" == [yY] ]] || exit 1
fi

# Served inside the machine by openssl s_server, with a certificate the machine trusts.
RELEASE_URL=https://localhost:8443/releases
ALARM_ROOTFS=https://fl.us.mirror.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz
KEYS="$HERE/run/release-key"
RELEASES="$HERE/run/releases"
# Every release signed with notes, as public ones are: the manifest then has a field after the size.
NOTES="$HERE/run/NOTES.md"
export RELEASE_KEY_PASSPHRASE=test-release-key-passphrase

echo '==> Building and signing the release (a test key)'
rm -rf "$KEYS" "$RELEASES"
printf '%s\n' "The install test's release." >"$NOTES"
(
  cd "$ROOT" &&
    npm run release:key -- "$KEYS" &&
    RELEASE_URL="$RELEASE_URL" RELEASE_PUB="$KEYS/release.pub" npm run release &&
    npm run release:sign -- --key "$KEYS/release.key" --notes "$NOTES" &&
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
    # Docker's own architecture, not this machine's name for it (a Mac says arm64).
    if [[ "$(docker info --format '{{.Architecture}}')" == aarch64 ]]; then
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
    echo '==> Starting the test machine (an Ubuntu 26.04 container with systemd)'
    docker build -q -t ilex-test-machine-ubuntu --build-arg BASE=ubuntu:26.04 \
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
      for machine in "$NAME" "$NAME-from"; do
        docker rm -f "$machine" >/dev/null 2>&1 || true
        docker volume rm -f "$machine-docker" "$machine-containerd" "$machine-backup" >/dev/null 2>&1 || true
      done
    fi
  }
  trap 'cleanup; release_lock' EXIT
  for _ in $(seq 1 30); do
    state="$(run_in systemctl is-system-running 2>/dev/null || true)"
    [[ "$state" == running || "$state" == degraded ]] && break
    sleep 1
  done
else
  # shellcheck source=vm.sh
  . "$HERE/vm.sh"
  vm_start
  trap 'vm_cleanup; release_lock' EXIT
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

# Another program on the app's port (as Grafana's 3000 would be): refused before anything changes —
# the installer would otherwise believe that program's answer.
step 'install.sh refuses while another program answers on the app’s port'
run_in systemd-run --unit ilex-test-squatter \
  openssl s_server -quiet -www -accept 127.0.0.1:3000 -cert /srv/tls/cert.pem -key /srv/tls/key.pem >>"$LOG" 2>&1
run_in bash -c 'for _ in $(seq 1 20); do (: <>/dev/tcp/127.0.0.1/3000) 2>/dev/null && exit 0; sleep 0.5; done; exit 1'
if run_in bash -c "cd /root/ilex-$VERSION && ./install.sh --yes" >"$HERE/run/squatter.out" 2>&1 ||
  run_in test -e /etc/ilex/version || ! grep -q 'Another program answers on port 3000' "$HERE/run/squatter.out"; then
  tee -a "$LOG" <"$HERE/run/squatter.out"
  echo 'install.sh did not refuse a port another program answers on' | tee -a "$LOG"
  exit 1
fi
run_in systemctl stop ilex-test-squatter

step 'Installing (get-ilex.sh)'
if ! run_in bash /root/get-ilex.sh --yes >>"$LOG" 2>&1; then
  tail -40 "$LOG"
  exit 1
fi
# What the browser shows at its warning is what the installer said to compare.
if ! grep -qF "$(run_in cat /etc/ilex/tls/.self-signed)" "$LOG"; then
  echo '  FAIL the installer did not print the certificate’s fingerprint' | tee -a "$LOG"
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
# are (byte for byte) and find the app there. Moved as app.env says: systemd's socket follows, the
# old port is let go.
step 'Moving the app to port 3300 (app.env)'
run_in bash -c "sed -i 's/^PORT=.*/PORT=3300/' /etc/ilex/app.env &&
  systemctl daemon-reload && systemctl restart ilex.socket &&
  sha256sum /etc/ilex/app.env >/root/app.env.sha256 &&
  for _ in \$(seq 1 60); do curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3300/api/health && break; sleep 1; done &&
  curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3300/api/health &&
  ss -ltnpH 'sport = :3300' | grep -q 'pid=1,' && ! ss -ltnH 'sport = :3000' | grep -q ." >>"$LOG" 2>&1 ||
  { echo '  FAIL the app and its socket did not move to 3300' | tee -a "$LOG"; exit 1; }
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

# HTTPS on the network follows app.env, and the certificate is the installer's only while it's the
# one it made: a self-made one near its end is renewed, one of the person's own never touched.
installed_again() {
  if ! run_in bash -c "cd /root/ilex-$VERSION && ./install.sh --update" >>"$LOG" 2>&1; then
    tail -40 "$LOG"
    exit 1
  fi
}
own_certificate() { # $1: its name, $2: days
  run_in bash -c "set -e; cd /etc/ilex/tls
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days $2 -subj /CN=$1 \
      -keyout key.pem -out cert.pem 2>/dev/null
    chown root:ilex key.pem && chmod 0640 key.pem
    openssl x509 -noout -fingerprint -sha256 -in cert.pem | sed 's/^[^=]*=//' >/root/$1-fingerprint"
}
step 'HTTPS: a self-made certificate near its end renewed'
own_certificate old 10
run_in cp /root/old-fingerprint /etc/ilex/tls/.self-signed
installed_again
run_in bash -c '! cmp -s /root/old-fingerprint /etc/ilex/tls/.self-signed &&
  openssl x509 -noout -checkend $((800 * 86400)) -in /etc/ilex/tls/cert.pem >/dev/null &&
  [[ "$(openssl x509 -noout -fingerprint -sha256 -in /etc/ilex/tls/cert.pem | sed "s/^[^=]*=//")" == "$(cat /etc/ilex/tls/.self-signed)" ]] &&
  cp /etc/ilex/tls/.self-signed /root/https-fingerprint' ||
  { echo '  FAIL the self-made certificate was not renewed' | tee -a "$LOG"; exit 1; }
run_in node /root/smoke.mjs https | tee -a "$LOG"

step 'HTTPS turned off (no HTTPS_HOST in app.env)'
run_in bash -c "cp -p /etc/ilex/app.env /root/app.env.https && sed -i '/^HTTPS_HOST=/d' /etc/ilex/app.env"
installed_again
run_in node /root/smoke.mjs https | tee -a "$LOG"

step 'HTTPS on again, with a certificate of your own (kept, even near its end)'
run_in cp -p /root/app.env.https /etc/ilex/app.env
own_certificate own 5
run_in cp /root/own-fingerprint /root/https-fingerprint
installed_again
app_settings_kept 'turning HTTPS off and on again'
run_in node /root/smoke.mjs https | tee -a "$LOG"

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
    npm run release:sign -- --key "$KEYS/release.key" --version "$GOOD" --notes "$NOTES" &&
    npm run release:publish -- "$RELEASES" "$GOOD" &&
    npm run release:sign -- --key "$KEYS/release.key" --version "$BROKEN" --notes "$NOTES" &&
    npm run release:publish -- "$RELEASES" "$BROKEN"
) >>"$HERE/run/release.log" 2>&1 || { tail -20 "$HERE/run/release.log"; exit 1; }
run_in rm -rf /srv/www/releases
copy_in "$RELEASES" /srv/www/releases
run_in node /root/smoke.mjs self-update "$GOOD" updated | tee -a "$LOG"
app_settings_kept "the update to $GOOD"
run_in node /root/smoke.mjs self-update "$BROKEN" rolled_back | tee -a "$LOG"
app_settings_kept "the rolled-back update to $BROKEN"
# Every release updates from every older one (the project's rule): the oldest supported one is
# installed on a second machine, its own smoke test sets everything up, and ilex-update takes it
# straight to this release. Its release address and key are pointed at the test's (the archive
# carries the real ones) — the only change by hand.
if [[ -n "$FROM" && "$MODE" == container && "$OS" != arch ]]; then
  OLD_MACHINE="$NAME-from"
  if [[ -f "$FROM" ]]; then
    FROM_ARCHIVE="$FROM"
    cp "$HERE/smoke.mjs" "$HERE/run/smoke-from.mjs"
  else
    FROM_ARCHIVE="$HERE/run/ilex-$FROM.tar.gz"
    curl -fsSL --proto '=https' -o "$FROM_ARCHIVE" "$OLDEST_URL/download/v$FROM/ilex-$FROM.tar.gz"
    git -C "$ROOT" show "v$FROM:tools/vm/smoke.mjs" >"$HERE/run/smoke-from.mjs"
  fi
  FROM_DIR="$(tar -tzf "$FROM_ARCHIVE" | head -1 | cut -d/ -f1)"
  TARGET="$MAJOR.$((MINOR + 3)).0"
  step "From ${FROM_DIR#ilex-} straight to $TARGET (this release, ilex-update)"
  (
    cd "$ROOT" &&
      node tools/vm/repack-release.mjs "$ARCHIVE" "$TARGET" &&
      npm run release:sign -- --key "$KEYS/release.key" --version "$TARGET" --notes "$NOTES" &&
      npm run release:publish -- "$RELEASES" "$TARGET"
  ) >>"$HERE/run/release.log" 2>&1 || { tail -20 "$HERE/run/release.log"; exit 1; }
  old_in() { docker exec -i "$OLD_MACHINE" "$@"; }
  docker volume rm -f "$OLD_MACHINE-docker" "$OLD_MACHINE-containerd" "$OLD_MACHINE-backup" >/dev/null 2>&1 || true
  docker run -d --name "$OLD_MACHINE" --hostname ilex-test --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock \
    -v "$OLD_MACHINE-docker:/var/lib/docker" -v "$OLD_MACHINE-containerd:/var/lib/containerd" \
    -v "$OLD_MACHINE-backup:/mnt/backup" \
    "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    state="$(old_in systemctl is-system-running 2>/dev/null || true)"
    [[ "$state" == running || "$state" == degraded ]] && break
    sleep 1
  done
  old_in bash -c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates openssl iproute2 >/dev/null' >>"$LOG" 2>&1
  old_in mkdir -p /srv/www /srv/tls
  docker cp "$RELEASES" "$OLD_MACHINE:/srv/www/releases"
  docker cp "$FROM_ARCHIVE" "$OLD_MACHINE:/root/"
  docker cp "$HERE/run/smoke-from.mjs" "$OLD_MACHINE:/root/smoke-from.mjs"
  docker cp "$HERE/smoke.mjs" "$OLD_MACHINE:/root/smoke.mjs"
  docker cp "$KEYS/release.pub" "$OLD_MACHINE:/root/test-release.pub"
  old_in bash -c "cd /root && tar xzf $(basename "$FROM_ARCHIVE") && cd $FROM_DIR && ./install.sh --yes" >>"$LOG" 2>&1 ||
    { tail -40 "$LOG"; exit 1; }
  old_in node /root/smoke-from.mjs install | tee -a "$LOG"
  old_in bash -c '
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj /CN=localhost \
      -addext subjectAltName=DNS:localhost -keyout /srv/tls/key.pem -out /srv/tls/cert.pem 2>/dev/null
    cp /srv/tls/cert.pem /usr/local/share/ca-certificates/ilex-test-releases.crt && update-ca-certificates >/dev/null
    systemd-run --unit ilex-test-releases --working-directory=/srv/www \
      openssl s_server -quiet -WWW -accept 8443 -cert /srv/tls/cert.pem -key /srv/tls/key.pem
    printf "RELEASE_URL=https://localhost:8443/releases\n" >/etc/ilex/release.env
    install -m 0644 /root/test-release.pub /etc/ilex/release.pub
    for _ in $(seq 1 20); do curl -fsS -o /dev/null https://localhost:8443/releases/latest/download/latest.json && exit 0; sleep 0.5; done
    exit 1' >>"$LOG" 2>&1
  old_in node /root/smoke.mjs self-update "$TARGET" updated | tee -a "$LOG"
fi

step "Done — log: ${LOG#"$ROOT"/}"
