#!/usr/bin/env bash
# run.sh <name> <base image> "<extra packages>" [driver flags...]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="$1"; NAME="sudo-check-$1"; BASE="$2"; EXTRA="$3"; shift 3
docker build -q -t "$NAME" --build-arg BASE="$BASE" --build-arg EXTRA="$EXTRA" "$HERE" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock -v "$NAME-docker:/var/lib/docker" "$NAME" >/dev/null
for _ in $(seq 1 40); do s="$(docker exec "$NAME" systemctl is-system-running 2>/dev/null || true)"; [[ $s == running || $s == degraded ]] && break; sleep 1; done
# Before lingering: a running user manager keeps the groups it started with.
if docker exec "$NAME" getent group docker >/dev/null; then docker exec "$NAME" usermod -aG docker bob; fi
docker exec "$NAME" loginctl enable-linger alice
docker exec "$NAME" loginctl enable-linger bob
docker exec "$NAME" sh -c 'echo "Defaults timestamp_timeout=1" > /etc/sudoers.d/test; chmod 440 /etc/sudoers.d/test'
if [[ -n "${SUDO_RS:-}" ]]; then docker exec "$NAME" sh -c "$SUDO_RS"; fi
IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME")"
for _ in $(seq 1 20); do docker exec "$NAME" systemctl is-active -q ssh && break; sleep 1; done
timeout 900 node "$HERE/driver.mjs" "$IP" "$LABEL" "$@" || true
echo "# auth failures logged for alice: $(docker exec "$NAME" sh -c 'journalctl --no-pager -o cat | grep -E "auth.*fail|incorrect" | grep -c alice')"
docker exec "$NAME" sh -c 'journalctl --no-pager -o cat | grep -E "auth.*fail|incorrect" | grep alice' | sed "s/^/#   /"
docker rm -f "$NAME" >/dev/null; docker volume rm -f "$NAME-docker" >/dev/null
