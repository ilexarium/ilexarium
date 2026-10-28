# catalog

App **templates**: starting points, used once. After setup, the app's folder (`~/apps/<name>` by default) is the person's own Compose folder — they may change anything. Design: `docs/plans/acting_as_you.md` ("Templates").

```
catalog/<id>/
├── compose.yml     plain Compose: ${VARIABLES}, data in ./folders, the laris.template label
├── template.json   what each variable is, the backup preset, the web port (templateSchema)
└── icon.svg        shown on the card (only ever used in <img>)
```

Texts are translation keys in `packages/i18n/messages/*.json`: `catalog.<id>.description`, `catalog.<id>.fields.<KEY>.label` and `.help`, `catalog.<id>.note` (with `"note": true`: what changed in this version, what to copy), `catalog.<id>.backup.restoreNote` (with `backup.restoreNote`).

## Rules (checked by `apps/server/src/catalog/` at startup and in its tests)

- `template.json` matches `templateSchema` (`@laris/shared`). Every `${VAR}` in `compose.yml` is a field and every field is used.
- Each service carries the label `laris.template: <id>@<version>`.
- Versions in `.env` (`image: …:${NAVIDROME_VERSION}`): the widest compatible line the publisher tags, else an exact version — never `latest`, `nightly`, `develop` or another moving tag. Images that must match share one variable. Databases stay on their major (a literal tag).
- Data in folders inside the app's folder by default (`./data`), so a backup of the app takes it along. Field defaults may use `@account` (the person's `uid:gid`) and `@timezone`.
- `backup`: `stop` or `live`, and what to skip (relative to the app's folder) — the preset for the app's backup item.

No Compose policy and no warnings: the person may change anything; `docker compose config` is the only check before starting.

## Review checklist for a new template or version

1. The image comes from the project itself (official or verified publisher), multi-arch (amd64 and arm64).
2. Compare with the project's own Compose file; every difference is deliberate and commented at the top of `compose.yml`.
3. Bump `version` in `template.json` and the label whenever `compose.yml` changes; write `catalog.<id>.note` when a person updating needs to know something.
4. Texts in en, de and ar.
5. `npm test` passes (the catalog tests check every template).

Templates are updated by hand every few months: a newer version shows on an app's page as "Use the current template".
