# @laris/web

Angular front end (standalone, signals, zoneless) with Tailwind v4 and spartan/ui.

```sh
npm run dev:web           # from project/ — ng serve on :4200, proxies /api to :3000
npm test -w @laris/web
```

spartan/ui components are generated into `src/ui/` (import alias `@ui/*`) and are ours to edit:

```sh
cd apps/web && npx ng g @spartan-ng/cli:ui <component>
```
