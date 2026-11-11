# Ilexarium

A friendly web UI for running self-hosted services — and the Linux host underneath — without the terminal. Installed onto an existing Linux machine with one script; it holds no root of its own and acts with the signed-in person's own Linux account.

## Layout

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

## Development

Requires Node 26+, npm 12+, Docker.

```sh
npm install
npm run db:up         # Postgres on 127.0.0.1:5432
npm run dev:server    # terminal 1 — API on :3000
npm run dev:web       # terminal 2 — UI on :4200
npm run dev:shared    # optional — rebuild shared contracts on change
```

`npm test`, `npm run lint`, `npm run format` run across all workspaces. The server needs Linux; on a Mac it runs in a container (`npm run server:up`, then `npm run srv -- <command>`). Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md); security problems: [`SECURITY.md`](SECURITY.md).

## Licence

Ilexarium is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. It is distributed in the hope that it will be
useful, but **without any warranty**; without even the implied warranty of merchantability or
fitness for a particular purpose. See [`LICENSE`](LICENSE).
