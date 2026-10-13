# system

Host-side pieces installed onto the target machine: privileged wrapper scripts, the sudoers drop-in, systemd units/timers, the install script and the Docker socket proxy's allow-list. See `CLAUDE.md` in this folder for the rules — all changes here are review-required.

- `docker-socket-proxy/haproxy.cfg` — the only Docker API requests the app can make (read-only; on the official HAProxy image). Used by `dev/compose.dev.yml` now; by the app's production stack later.

- `wrappers/homelab-compose.mts` — the deploy wrapper: installs and removes catalog services with `docker compose` (TypeScript run by Node, zero dependencies). Installed root-owned as `/opt/homelab/libexec/homelab-compose.mts`. Tests: `wrappers/homelab-compose.spec.ts` (run by the server's unit tests).
- `sudoers/homelab` — the `/etc/sudoers.d/` drop-in: the app's user may run exactly that wrapper as root.
- `config/wrappers.json` — an example of `/etc/homelab/wrappers.json` (root-owned): the catalog folder, storage roots, reserved ports, platform folders, the docker binary.

Design: `docs/plans/service_deploys.md`. `install/` and `systemd/` are still empty (the installer feature).
