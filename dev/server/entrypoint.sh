#!/bin/sh
# Makes `dev` with your user and group ids (files written to the repository stay yours) and the
# Docker socket's group, gives it the node_modules volumes, then waits for `docker compose exec`.
set -eu
: "${HOST_UID:?}" "${HOST_GID:?}" "${DOCKER_GID:?}"
getent group "$HOST_GID" >/dev/null || groupadd -g "$HOST_GID" dev
getent group "$DOCKER_GID" >/dev/null || groupadd -g "$DOCKER_GID" docker-host
if ! getent passwd dev >/dev/null; then
  useradd -u "$HOST_UID" -g "$HOST_GID" -G "$(getent group "$DOCKER_GID" | cut -d: -f1)" \
    -m -s /bin/bash dev
fi
cd "$ILEX_REPO"
chown dev:"$HOST_GID" /home/dev node_modules apps/*/node_modules packages/*/node_modules
exec "$@"
