# catalog

Curated, **reviewed** service recipes. Each service is a folder:

```
catalog/<service-id>/
├── compose.yml   the recipe: a Docker Compose file with ${KEY} blanks
├── meta.json     the blanks (fields: type, default) + display info
└── icon.svg      shown on the catalog card (only ever used in <img>)
```

Texts (description, field labels and help) are translation keys in `packages/i18n/messages/*.json`: `catalog.<id>.description`, `catalog.<id>.fields.<KEY>.label` and `.help` (not for `generatedSecret` fields).

How it's used and why: `docs/plans/service_deploys.md`. In production the catalog is installed root-owned; the root wrapper (`system/wrappers/homelab-compose.ts`) reads recipes only from there — the app never hands it a Compose file, only an id and values.

## Rules (checked by `apps/server/src/catalog/` at startup and in its tests, and again by the wrapper)

- `meta.json` matches `catalogMetaSchema` (`@homelab/shared`). Every `${KEY}` in `compose.yml` is a declared field and every field is used. No other `$` substitution (write `$$` for a literal `$`).
- Values fill blanks only: ports as `'${PORT}:<container port>'`, folders as long-syntax bind mounts whose `source` is exactly `${PATH_FIELD}` (`read_only: true` for `access: "read"`).
- Never: `privileged`, `cap_add`, `devices`, host namespaces (`network_mode`, `pid`, `ipc`, `uts`, `userns_mode`, `cgroup`), `security_opt` unconfined or `label:disable`, `sysctls`, `build`, `extends`, `include`, `env_file`, file-based `secrets`/`configs`, external networks or volumes, `container_name`, `homelab.*` labels, other bind mounts (never the Docker socket).
- Always: images pinned by digest (`name:tag@sha256:…`, multi-arch: amd64 and arm64), `restart: unless-stopped`, `logging` with `max-size`.
- Named volumes for a service's internal data; folder fields for what a person may want to see or fill. `dataOwner` is the user the containers write as — the owner of folders the wrapper creates.

## Review checklist for a new entry or version

1. The image comes from the project itself (official or verified publisher); the digest is the multi-arch index for the stated tag (`docker buildx imagetools inspect <image:tag>`).
2. Compare with the project's own Compose file; every difference is deliberate and commented at the top of `compose.yml`.
3. Each folder field's `access` is the least the service needs (`read` unless it must write).
4. Secrets: `generatedSecret` for internal passwords (letters and digits only — some images refuse others), `secret` only for what the user must know.
5. Bump `version` in `meta.json` whenever `compose.yml` changes.
6. `npm test` passes (the catalog tests run every rule against every entry).
