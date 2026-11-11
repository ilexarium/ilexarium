# Development and tests only: an SSH server standing in for the machine's own sshd, for the
# Linux sign-in, the file explorer and ending processes. Two people:
#   anna / anna-dev-password (uid 1500) — the one the tests sign in as; her sudo may start
#     ilex-root (and nothing else), the root half of the helper
#   bob  / bob-dev-password  (uid 1501) — whose home is private (permission denied for anna); no sudo
# Its host keys are made at the first start into /keys, a folder shared with the app
# (apps/server/.dev/sshd), which pins them like production pins /etc/ssh/ssh_host_*_key.pub.
# Node 24 runs the helper and ilex-root (system/programs/, mounted where the installer puts it).
# A fake systemctl with sample units and a fake journalctl with sample lines (no systemd in a
# container).
# Docker's CLI with Compose, no daemon: the helper's Compose check (`config`) needs none; tasks
# themselves are the install test's.
FROM node:24-slim AS node
FROM docker:29-cli AS docker

FROM debian:13-slim
COPY --from=node /usr/local/bin/node /usr/bin/node
COPY --from=docker /usr/local/bin/docker /usr/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose /usr/libexec/docker/cli-plugins/docker-compose
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server sudo procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd --create-home --uid 1500 --shell /bin/bash anna \
 && useradd --create-home --uid 1501 --shell /bin/bash bob \
 && echo 'anna:anna-dev-password' | chpasswd \
 && echo 'bob:bob-dev-password' | chpasswd \
 && chmod 0700 /home/bob \
 && echo 'anna ALL=(root) /opt/ilex/libexec/ilex-root.mts' > /etc/sudoers.d/anna && chmod 0440 /etc/sudoers.d/anna \
 && echo 'secret' > /home/bob/private.txt && chown bob:bob /home/bob/private.txt \
 && rm -f /etc/ssh/ssh_host_*
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
# No systemd in here: sample units for the Services page.
COPY --chmod=0755 fake-systemctl.cjs /usr/bin/systemctl
# And sample lines for the Logs page.
COPY --chmod=0755 fake-journalctl.cjs /usr/bin/journalctl
EXPOSE 22
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
