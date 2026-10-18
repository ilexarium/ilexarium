#!/bin/sh
# Makes the host key once (kept in the shared folder), then runs sshd in the foreground.
set -eu
if [ ! -f /keys/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /keys/ssh_host_ed25519_key
fi
chmod 0644 /keys/ssh_host_ed25519_key.pub
exec /usr/sbin/sshd -D -e
