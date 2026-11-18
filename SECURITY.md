# Security

Ilexarium manages a Linux machine, so security problems matter a lot here. Thank you for reporting one.

## Reporting a problem

Please report it **privately**: on GitHub, open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue, pull request or discussion for it.

Say what you found, how to reproduce it, and what an attacker could do with it. A proof of concept helps but isn't required. You'll get an answer as soon as possible. Once a fix is released, the report can be published, with credit to you if you want it.

## Supported versions

Only the newest release gets security fixes. Ilexarium can update itself from Settings → Updates.

## What counts

Anything that gets around Ilexarium's safety rules, for example:

- doing something on the machine without signing in, or as someone else
- getting root, or another Linux account's rights, without that account's password
- reaching the Docker API beyond the socket proxy's allow-list (`system/docker-socket-proxy/haproxy.cfg`)
- reading secrets: passwords, the backup passphrase, alert channel secrets, containers' environment
- running a command through input that should only ever be data (a shell string, a path outside its allowed area)
- getting the helper or a root program (`system/programs/`) to do more than its fixed list of actions

These are by design and not vulnerabilities:

- A signed-in person can do what their own Linux account can do (that's what Files, the terminal and the apps are for). A person in the `docker` group effectively has root, as on any machine.
- While someone's sudo is unlocked (up to 15 minutes after their last root action), the app can do root work for them. So can any other program running as that same account: Ilexarium can't tell its requests from theirs, and each request keeps the unlock alive. A program running as a sudoer could as well wait for their next `sudo` in a terminal.
- Signed in to Ilexarium alone (no Linux sign-in), a person can start, stop and restart containers (except Ilexarium's own), remove unused images, empty the build cache and delete Docker volumes no container uses. These are the socket proxy's only writes.
- Signing in needs HTTPS. Unless installed with `--local-only`, Ilexarium serves it on port 3443 on every address of the machine, with its own self-signed certificate; a proxy you choose can use `127.0.0.1:3000`.

## How Ilexarium is protected

- **The app has no root.** It runs as its own unprivileged Linux user, with no sudoers rule, no `NOPASSWD` and no access to Docker's socket.
- **Docker only through an allow-list.** The app talks to a proxy (`system/docker-socket-proxy/haproxy.cfg`) that lets through reads and the six changes listed above, nothing else. Ilexarium's own containers can't be stopped from the app.
- **Changes run as you.** Files, the terminal and app changes run as your own Linux account, over SSH to this machine. Everything except the terminal goes through a small helper (`system/programs/ilex-helper.mts`) that accepts a fixed list of actions as JSON and never runs a shell. Signing in as root is refused.
- **Root only through your own sudo.** Unlocking it with your password starts `ilex-root`, which does the privileged actions and ends 15 minutes after its last one, at "Lock now", or when you sign out. Your password is never stored.
- **Backups run without the app.** A root program started by a systemd timer runs them. The passphrase is kept only in a file only root can read.
- **Updates are signed.** Every release is signed, and the key is in `get-ilex.sh` and the README. An update is checked before it installs, and a failed update rolls back.
- **Audit first.** Every privileged action writes its audit record before it acts. If the record can't be written, nothing happens.
- **No shell strings, checked paths, no dependencies in the privileged parts.** The helper and the root programs use only Node's built-ins.

## Trade-offs and known limits

- **SSH passwords from this machine.** The installer adds `/etc/ssh/sshd_config.d/ilex.conf`, which allows password sign-ins only for connections from `127.0.0.1` and `::1`. Connections from the network keep your own settings. Ilexarium checks your Linux password through SSH because any other way would need root. The flip side: a program on the machine itself can try passwords over localhost, within SSH's own limits.
- **The sign-in page on your network.** By default anyone who reaches the machine on port 3443 sees the sign-in page (as with Cockpit, Proxmox or TrueNAS). Sign-ins are rate-limited per address and per account. `--local-only` at install, or removing `HTTPS_HOST` from `/etc/ilex/app.env`, keeps it on this machine for a proxy of your choice. Ilexarium doesn't check whether the machine has a public address: don't expose port 3443 to the internet.
- **The first visit trusts a self-signed certificate.** The browser can't check it, so the first visit is where someone on your network could pretend to be your server. The installer prints the certificate's SHA-256 fingerprint: compare it with the one your browser shows before you go on. Your own certificate (for example Let's Encrypt, or `tailscale cert`) can replace it: `/etc/ilex/tls/cert.pem` and `key.pem` (the key `root:ilex 0640`), then `sudo systemctl restart ilex`. The installer never replaces a certificate it didn't make.
- **The 15-minute unlock** matches sudo's own default. Use "Lock now" when you're done.
- **No independent audit yet.** Ilexarium has had several in-depth internal reviews, but no outside audit. Outside reviews are very welcome. A good place to start is `system/programs/` and the parts listed in [`CONTRIBUTING.md`](CONTRIBUTING.md#parts-that-need-a-careful-review).

## How it's built

Ilexarium is written with the help of AI coding assistants for planning, code, tests and reviews. Every change is planned and reviewed by the maintainer before it's merged. The safety rules in [`CONTRIBUTING.md`](CONTRIBUTING.md#safety-rules) apply to every line, whoever or whatever wrote it. The parts that run as root or as you get a line-by-line review, have their own tests, and are tested on real installs before every release.
