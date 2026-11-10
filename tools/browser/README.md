# Seeing the app in a browser

Headless Chromium (Playwright 1.63, Apache 2.0) to check UI changes in a real browser. Its own
package (`npm install` here once), not an npm workspace — none of it ships with the app; what it
makes (`run/`) and `node_modules/` stay out of git. Claude uses it to see what it built; you can
too.

```sh
cd tools/browser
./start.sh --reset          # build, then start a separate copy of the app (first time / clean slate)
node check.mjs /backups     # screenshots: phone, tablet, desktop × English, Arabic × light, dark
./stop.sh
```

- **Separate from development:** server on :3100, production web build on :4400 — never the dev
  servers (:3000, :4200) or the dev database. It uses `ilex_test` (the e2e tests reset it too)
  and pretend backup disks under `run/state/mnt/`. `--reset` empties the test database: the next
  sign-in goes through setup (as `owner` / `correct horse battery staple`).
- **Needs:** the dev stack up (`npm run db:up` at the repository root); Borg for backup flows.
- **Writing a check:** `lib.mjs` gives a signed-in page in any language, theme and size
  (`openPage`), records console errors and sideways scrolling, and `finish()` reports them.
  `check.mjs` is the simplest example; drive clicks with Playwright's `page.click`,
  `page.getByRole`, then `page.screenshot`.
- **The app's rate limits apply:** at most 10 sign-ins and 30 `/api/auth/*` requests a minute
  per address, and every page load asks `/api/auth` twice. `lib.mjs` signs in once and reuses
  the session; load few pages (resize one page with `page.setViewportSize` instead of
  reloading per size). If a check suddenly can't find the login form, wait a minute.
- **From Claude's Bash tool:** send the output to a file (`./start.sh --reset > run/start.log
2>&1 < /dev/null`), never through a pipe: the servers start detached, but the tool then
  waits on the pipe for ever.
- **Builds what users get:** the production web build — so minification bugs show up here
  (the dev server and unit tests don't minify).
- Everything it makes is in `run/` (build, state, logs, screenshots); delete it any time.
  Chromium itself is in `~/.cache/ms-playwright`.
