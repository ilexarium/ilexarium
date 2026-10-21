# Laris

A friendly web UI for running self-hosted services — and the Linux host underneath — without the terminal. See `../docs/` for vision and technical decisions.

## Layout

| Path              | What                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `apps/web`        | Angular front end                                                |
| `apps/server`     | Nest.js back end                                                 |
| `packages/shared` | Contracts shared by both: types + Zod schemas                    |
| `catalog`         | Curated service definitions (Compose template + metadata)        |
| `system`          | Host-side: wrapper scripts, sudoers, systemd, install (⚠ review) |
| `dev`             | Local development infrastructure (Postgres)                      |

## Development

Requires Node 26+, npm 12+, Docker.

```sh
npm install
npm run db:up         # Postgres on 127.0.0.1:5432
npm run dev:server    # terminal 1 — API on :3000
npm run dev:web       # terminal 2 — UI on :4200
npm run dev:shared    # optional — rebuild shared contracts on change
```

`npm test`, `npm run lint`, `npm run format` run across all workspaces.
