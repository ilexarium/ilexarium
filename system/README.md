# system

Host-side pieces installed onto the target machine: privileged wrapper scripts, the sudoers drop-in, systemd units/timers, the install script and the Docker socket proxy's allow-list. See `CLAUDE.md` in this folder for the rules — all changes here are review-required.

- `docker-socket-proxy/haproxy.cfg` — the only Docker API requests the app can make (read-only; on the official HAProxy image). Used by `dev/compose.dev.yml` now; by the app's production stack later.

The rest is empty for now; populated as features need privileged actions.
