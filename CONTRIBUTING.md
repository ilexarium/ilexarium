# Contributing

Thanks for your interest in Ilexarium. Bug reports, ideas and questions are welcome as GitHub issues.

**Before writing code, please open an issue** and describe what you'd like to change. Ilexarium changes a real machine, so the design is settled first: that way nobody spends time on a pull request that can't be merged. Security problems never go in an issue: see [`SECURITY.md`](SECURITY.md).

## Setting up

See the [README](README.md) for running it locally. The server needs Linux. On a Mac it runs in a container (`dev/server/`): `npm run db:up`, `npm run server:up`, then `npm run srv -- <command>`.

| Path              | What                                                            |
| ----------------- | --------------------------------------------------------------- |
| `apps/web`        | Angular front end                                               |
| `apps/server`     | Nest.js back end                                                |
| `packages/shared` | Contracts shared by both: types + Zod schemas                   |
| `packages/i18n`   | Translations (English, German, Arabic)                          |
| `catalog`         | App templates (Compose file + form + icon)                      |
| `system`          | Host-side: helper, root programs, systemd, installer (⚠ review) |
| `dev`             | Local development: Postgres, Docker proxy, a test SSH server    |
| `tools`           | Browser checks, the install test, logo and font builds          |

`npm run dev:shared` rebuilds the shared contracts on change.

Before a pull request, the whole suite must pass. One command runs it:

```sh
npm run db:up                  # the services the e2e tests need: Postgres, the Docker proxy, sshd
npm run verify                 # on a Mac: npm run srv -- npm run verify
```

It builds the shared packages, then runs, in this order (each part's name in brackets):

- `[lint]` `npm run lint`: the workspaces and the type check of the root programs
- `[format]` `npm run format:check`
- `[unit]` every workspace's unit tests: shared, i18n, the server with the helper and the root programs, the web app
- `[e2e]` the server's integration and e2e tests; a test skipped because a dev service or Borg (`borgbackup`) is missing counts as a failure

The install test (`[install]`) is left out unless asked for: it runs the installer in a privileged Docker container (or a VM), see [`tools/vm/README.md`](tools/vm/README.md).

`npm run verify -- --only lint,unit` runs some parts. A change to the installer, `system/`, the helper, the root programs, the database or how a release is built needs the install test before it is merged. You don't have to run it yourself: say so in the pull request and a maintainer runs it.

GitHub runs lint, format, unit and e2e on every pull request and every push to `main` (`.github/workflows/ci.yml`). The install test runs there only when a maintainer starts the workflow by hand ("Run workflow", after reading the change) or by a release: `npm run ship` releases only a commit pushed as `main`, starts the whole workflow for it and goes on only when every job passed.

## Safety rules

These rules are why people can trust Ilexarium with their machine. A pull request that breaks one isn't merged, however useful it is.

- **The user confirms every change.** The app never changes the system on its own.
- **The app holds no root.** It runs as its own unprivileged user. It never has a sudoers rule or `NOPASSWD`, and no Docker write access of its own. Changes run as the signed-in person's Linux account (through the helper), and root only through that person's own sudo, unlocked with their password (`ilex-root`).
- **No shell strings.** Never build a command by joining strings. Run a program from a fixed path with an argument list, and never let user input become part of the command. Root programs take their values on stdin, never as arguments.
- **Paths are checked.** Resolve every path fully, confirm it's inside its allowed area, and only then act. No `../` tricks.
- **Docker only through the allow-list.** The app talks to Docker through the socket proxy (`system/docker-socket-proxy/`), never Docker's socket. A new kind of Docker change needs a new proxy rule and a new method in `DockerControl` (`apps/server/src/docker/`).
- **Audit first.** A privileged action writes its audit record before it acts. If the record can't be written, the action doesn't happen.
- **Secrets stay secret.** Passwords, the backup passphrase, channel secrets and containers' environment values never go into logs, audit details, error messages or the browser.
- **Validate on the server.** All input is checked with the Zod schemas in `packages/shared`, whatever the web app already checked.
- **No dependency that runs commands.** The helper and the root programs have zero dependencies (only `node:` built-ins), and nothing in the app may start programs for us.

### Parts that need a careful review

Changes to these get a slow, line-by-line review. Point them out in your pull request:

- everything in `system/`: the helper and the root programs (`programs/`), systemd units, the installer, the Docker proxy's allow-list, the `sshd` drop-in
- `apps/server/src/root-programs/`, `apps/server/src/linux-sessions/`, `apps/server/src/docker/`
- sign-in and sessions (`apps/server/src/auth/`), and the Content Security Policy (`apps/server/src/common/security-headers*`)

A new helper or root program action, a new proxy rule or a widened one, and a new systemd unit each need a reason in the pull request. A rule that both the app and a program check also goes in `system/programs/rules-match-app.spec.ts`.

## AI assistants

You may use AI coding assistants. Ilexarium is built with them too. You're responsible for everything you send:

- Understand every line and be able to explain it. The safety rules apply whoever or whatever wrote the code.
- Say in the pull request that you used one, and for what.
- Check a security report yourself before sending it. A report an AI wrote that nobody has reproduced will be closed.

## Code style

- Small, focused commits and pull requests: one change each.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (see below).
- Every user-visible text is a translation key in `packages/i18n/messages/en.json`, also added to `de.json` and `ar.json` (a test checks this). Layouts use start/end, never left/right, because Arabic reads right to left.
- Pages must work on phones too: no sideways scrolling, nothing that needs hover.
- Comments only for what the code can't say: a reason, a security rule, a trap.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, then a blank line and an optional body.

```
fix(server): keep stopped containers in the apps list

Docker 29 sends "Ports": null for a stopped container, which the
schema refused, so the container vanished until the next start.
```

- **Subject:** at most 72 characters in all, imperative mood ("add", not "added"), lowercase after the colon, no full stop. Say what changed; keep the details for the body.
- **Body:** why the change was made and what the diff can't show (a trap, a decision, how it was tested), wrapped at 72 characters.
- **Breaking change:** `!` before the colon (`feat(installer)!: …`) and a `BREAKING CHANGE:` line in the body saying what an update needs.

| Type       | For                                                   |
| ---------- | ----------------------------------------------------- |
| `feat`     | a new feature or behaviour                            |
| `fix`      | a bug fix                                             |
| `refactor` | a code change that changes no behaviour               |
| `perf`     | faster or lighter                                     |
| `test`     | tests only                                            |
| `docs`     | documentation (README, SECURITY.md, guides, comments) |
| `build`    | dependencies, npm, how a release is built             |
| `ci`       | the GitHub workflows                                  |
| `chore`    | anything else (formatting, clean-up)                  |
| `revert`   | undoing an earlier commit                             |

| Scope       | What                                                            |
| ----------- | --------------------------------------------------------------- |
| `web`       | `apps/web`                                                      |
| `server`    | `apps/server`                                                   |
| `shared`    | `packages/shared`                                               |
| `i18n`      | `packages/i18n`                                                 |
| `system`    | `system/`: the helper, root programs, systemd, the Docker proxy |
| `installer` | `system/install/`                                               |
| `catalog`   | `catalog/`                                                      |
| `tools`     | `tools/` and `dev/`                                             |
| `release`   | the release scripts (`scripts/`)                                |
| `deps`      | dependency updates                                              |

A change across several areas takes the main one's scope, or none.

## Licence

Ilexarium is licensed under the GNU General Public License, version 3 or later. By sending a contribution, you agree it's licensed the same way.
