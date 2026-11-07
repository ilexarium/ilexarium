# Development only: a Linux machine for the server and its tests, for working from a Mac (or any
# machine without the Linux the server reads: /proc, /sys, Borg). The repository is mounted at
# the same path as on the host; node_modules are this container's own volumes (Linux builds).
# Started by `npm run server:up`, commands run with `npm run srv -- <command>`.
FROM docker:29-cli AS docker

# Debian 13, like the install test. Its `node` user (uid 1000) goes: `dev` takes your ids.
FROM node:26-trixie-slim
# The programs' shebang is /usr/bin/node, as installed.
RUN userdel -r node && ln -s /usr/local/bin/node /usr/bin/node
COPY --from=docker /usr/local/bin/docker /usr/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose /usr/libexec/docker/cli-plugins/docker-compose
# Borg for the backup program (run directly in development), git and procps for tests and you.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      borgbackup ca-certificates curl git procps openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["sleep", "infinity"]
