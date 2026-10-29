# Development and tests only: an SSH server standing in for the machine's own sshd, for the
# Linux sign-in, the file explorer and ending processes (docs/plans/files_and_terminal.md,
# process_list.md). Two people:
#   anna / anna-dev-password (uid 1500) — the one the tests sign in as; her sudo may start
#     laris-root (and nothing else), the root half of the helper (docs/plans/laris_root.md)
#   bob  / bob-dev-password  (uid 1501) — whose home is private (permission denied for anna); no sudo
# Its host keys are made at the first start into /keys, a folder shared with the app
# (apps/server/.dev/sshd), which pins them like production pins /etc/ssh/ssh_host_*_key.pub.
# Node 24 runs the helper and laris-root (system/programs/, mounted where the installer puts it).
FROM node:24-slim AS node

FROM debian:13-slim
COPY --from=node /usr/local/bin/node /usr/bin/node
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server sudo procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd --create-home --uid 1500 --shell /bin/bash anna \
 && useradd --create-home --uid 1501 --shell /bin/bash bob \
 && echo 'anna:anna-dev-password' | chpasswd \
 && echo 'bob:bob-dev-password' | chpasswd \
 && chmod 0700 /home/bob \
 && echo 'anna ALL=(root) /opt/laris/libexec/laris-root.mts' > /etc/sudoers.d/anna && chmod 0440 /etc/sudoers.d/anna \
 && echo 'secret' > /home/bob/private.txt && chown bob:bob /home/bob/private.txt \
 && rm -f /etc/ssh/ssh_host_*
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
