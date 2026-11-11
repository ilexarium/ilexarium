# sudo cache check

A check made before the helper was built: does a `sudo` cache made in the helper's terminal stay in that terminal, and do long tasks outlive the SSH session? A throwaway machine per run (privileged container with systemd, sshd, two users), a helper prototype (`helper.mjs`) and a driver that signs in over SSH like the server does (`driver.mjs`). Results: the plan's "Step 0 results".

    ./run.sh <name> <image> "<extra packages>" [--wait] [--docker] [--no-p]

- `--wait`: the timeout checks (2½ minutes; the machine sets `timestamp_timeout=1`).
- `--docker`: `docker compose up` as a `docker` group member (bob, a user unit) and through `sudo` (alice, a system unit). Debian 13: `"docker.io docker-cli docker-compose"`.
- `--no-p`: leave out `sudo -p ''` (`sudo-rs` 0.2.2 refuses it).
- `SUDO_RS='…'`: a command run in the machine first, e.g. installing `sudo-rs` and linking `/usr/bin/sudo` to `/usr/lib/cargo/bin/sudo`.

Examples: `./run.sh debian13 debian:13 "docker.io docker-cli docker-compose" --wait --docker`, `./run.sh debian12 debian:12 "" --wait`. Don't edit `run.sh` while a run is using it (bash reads it as it goes).
