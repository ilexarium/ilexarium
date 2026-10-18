# Development and tests only: an SSH server standing in for the machine's own sshd, for the
# Linux sign-in and the file explorer (docs/plans/files_and_terminal.md). Two people:
#   anna / anna-dev-password (uid 1500) — the one the tests sign in as
#   bob  / bob-dev-password  (uid 1501) — whose home is private (permission denied for anna)
# Its host keys are made at the first start into /keys, a folder shared with the app
# (apps/server/.dev/sshd), which pins them like production pins /etc/ssh/ssh_host_*_key.pub.
FROM debian:13-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd --create-home --uid 1500 --shell /bin/bash anna \
 && useradd --create-home --uid 1501 --shell /bin/bash bob \
 && echo 'anna:anna-dev-password' | chpasswd \
 && echo 'bob:bob-dev-password' | chpasswd \
 && chmod 0700 /home/bob \
 && echo 'secret' > /home/bob/private.txt && chown bob:bob /home/bob/private.txt \
 && rm -f /etc/ssh/ssh_host_*
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
