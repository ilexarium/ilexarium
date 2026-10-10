# @homelab/server

Nest.js backend: REST API (prefix `/api`), WebSocket gateways, auth, Docker control and the command executor.

```sh
npm run dev:server        # from project/ — builds @homelab/shared, then nest --watch on :3000
npm test -w @homelab/server
npm run test:e2e -w @homelab/server
npm run lint -w @homelab/server
```
