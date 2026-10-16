// Screenshots one page in every size, English and Arabic, light and dark.
// Usage: node check.mjs /backups [out-folder]   (default out: run/shots)
// One page load per language and theme, resized for each size: the app limits /api/auth/* to
// 30 requests a minute per address, and every load asks it twice.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE, checkNoSideScroll, finish, openPage, SIZES } from './lib.mjs';

const path = process.argv[2] ?? '/';
const out = process.argv[3] ?? fileURLToPath(new URL('./run/shots', import.meta.url));
mkdirSync(out, { recursive: true });
const name = path.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home';

for (const lang of ['en', 'ar']) {
  for (const theme of ['light', 'dark']) {
    const { page, context } = await openPage({ lang, theme });
    await page.goto(`${BASE}${path}`);
    // Not 'networkidle': the app's WebSocket stays open, so it never settles.
    await page.waitForLoadState('load');
    for (const [size, viewport] of Object.entries(SIZES)) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(800);
      const tag = `${lang} ${theme} ${size}`;
      await checkNoSideScroll(page, tag);
      await page.screenshot({
        path: `${out}/${name}-${lang}-${theme}-${size}.png`,
        fullPage: true,
      });
    }
    await context.close();
  }
}
console.log(`screenshots in ${out}`);
await finish();
