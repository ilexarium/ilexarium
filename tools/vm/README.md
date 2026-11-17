# The install test

`test-install.sh` tests Ilexarium's installer end to end on a throwaway machine. It builds a
release signed with a test key, installs it the way a user does (`get-ilex.sh`), runs the smoke
test inside (`smoke.mjs`: sign-in, apps, backups and restores through sudo, files, alerts, …),
installs again as an update and checks again, and updates the oldest supported release
(`oldest-release`) straight to this one.

You don't need it for most changes: the unit and e2e tests (`npm run verify`) cover the code.
It's for changes to the installer, `system/`, the helper and root programs, the database or how a
release is built. Maintainers run it for such pull requests.

## Two ways to run it

| Mode        | Command                                | Isolation                                            |
| ----------- | -------------------------------------- | ---------------------------------------------------- |
| A VM        | `tools/vm/test-install.sh --vm`        | Full: a QEMU VM. Needs Linux with KVM.               |
| A container | `tools/vm/test-install.sh --container` | **None to speak of:** a privileged Docker container. |

The container mode needs systemd and Docker inside the test machine, so the container is
`--privileged`: it can reach this machine's devices and kernel, as root can. Nothing in the test
does (no disks mounted or formatted, no kernel settings changed), but a broken installer or base
image wouldn't be contained. That's why it asks before starting (`--yes` skips the question) and
why `npm run verify` leaves it out unless asked for (`npm run verify -- --only install`). Use
the VM, or a machine you don't mind, when in doubt.

Options: `--os ubuntu` or `--os arch` (container mode), `--from <version>|<archive>|none` (the
older release to update from), `--keep` (leave the machine running to look around). One run at a
time. It takes several minutes and downloads app images from Docker Hub inside the test machine.

## What it leaves behind

- `tools/vm/run/`: logs (`container.log`, `release.log`), the test key, the served release
- `release/`: the built archive
- Docker images `ilex-test-machine*` (kept as a cache between runs)

`tools/vm/test-install.sh --clean` removes the test machines, their volumes and images, and
`tools/vm/run/`.
