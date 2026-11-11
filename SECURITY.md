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
- While someone's sudo is unlocked (up to 15 minutes after their last root action), the app can do root work for them.
- Signing in needs HTTPS from a proxy you choose. Ilexarium itself listens only on `127.0.0.1`.
