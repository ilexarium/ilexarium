ARG BASE=debian:13
FROM ${BASE}
ARG EXTRA=""
ENV container=docker
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session libpam-systemd sudo openssh-server nodejs ca-certificates ${EXTRA} \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty.target console-getty.service systemd-firstboot.service \
 && systemctl enable ssh \
 && printf 'PasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/test.conf \
 && useradd -m -s /bin/bash -G sudo alice && echo 'alice:alice-pw' | chpasswd \
 && useradd -m -s /bin/bash -G sudo bob && echo 'bob:bob-pw' | chpasswd \
 && mkdir -p /opt/proto
COPY helper.mjs /opt/proto/helper.mjs
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
