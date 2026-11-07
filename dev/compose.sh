#!/bin/sh
# `docker compose` for dev/compose.dev.yml, with what it needs from this machine (Linux or macOS).
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
export LARIS_REPO="$repo"
HOST_UID=$(id -u)
HOST_GID=$(id -g)
export HOST_UID HOST_GID
# The Docker socket's group as containers see it: on macOS the socket lives in Docker's Linux VM.
if [ -z "${DOCKER_GID:-}" ]; then
  DOCKER_GID=$(docker run --rm -v /var/run/docker.sock:/s busybox:1.37 stat -c %g /s)
fi
export DOCKER_GID
exec docker compose -f "$repo/dev/compose.dev.yml" "$@"
