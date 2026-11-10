// Shared by the checks: a browser on the app started by start.sh, signed in, with the language,
// theme and screen size wanted — and what went wrong (console errors, sideways scrolling).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BASE = 'http://localhost:4400';
export const SIZES = {
  phone: { width: 375, height: 812 },
  tablet: { width: 820, height: 1100 },
  desktop: { width: 1280, height: 900 },
};
export const OWNER = { username: 'owner', password: 'correct horse battery staple' };
const SETUP_TOKEN = fileURLToPath(new URL('./run/state/setup-token', import.meta.url));

export const problems = [];
export const browser = await chromium.launch();

/** The session, signed in once (the app allows only 10 sign-ins a minute per address). */
let session = null;

/** A signed-in page. `lang`: en | de | ar; `theme`: light | dark; `size`: a key of SIZES. */
export async function openPage({ lang = 'en', theme = 'light', size = 'desktop' } = {}) {
  if (!session) {
    const first = await browser.newContext();
    const page = await first.newPage();
    await signIn(page);
    session = await first.storageState();
    await first.close();
  }
  const context = await browser.newContext({ viewport: SIZES[size], storageState: session });
  await context.addInitScript(
    ([l, t]) => {
      // The app's keys: LANGUAGE_STORAGE_KEY and THEME_STORAGE_KEY (apps/web/src/app/core/…).
      localStorage.setItem('ilex.language', l);
      localStorage.setItem('ilex.theme', t);
    },
    [lang, theme],
  );
  const page = await context.newPage();
  const tag = `${lang} ${theme} ${size}`;
  page.on('console', (m) => m.type() === 'error' && problems.push(`[${tag}] console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${tag}] page error: ${e.message}`));
  return { page, context, tag };
}

/** Signs in as the owner — through setup first when the database is empty (start.sh --reset). */
async function signIn(page) {
  const status = await (await fetch(`${BASE}/api/auth/status`)).json();
  if (status.needsSetup) {
    await page.goto(`${BASE}/setup`);
    await page.fill('#setupToken', readFileSync(SETUP_TOKEN, 'utf8').trim());
    await page.fill('#username', OWNER.username);
    await page.fill('#password', OWNER.password);
    await page.fill('#confirmPassword', OWNER.password);
  } else {
    await page.goto(`${BASE}/login`);
    await page.fill('#username', OWNER.username);
    await page.fill('#password', OWNER.password);
  }
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/`);
}

/** Records it if the page scrolls sideways (a bug: see CLAUDE.md, responsive rules). */
export async function checkNoSideScroll(page, tag) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 1) problems.push(`[${tag}] the page scrolls sideways by ${wide}px`);
}

/** Closes the browser and prints what went wrong (exit code 1 if anything did). */
export async function finish() {
  await browser.close();
  console.log(problems.length ? problems.join('\n') : 'no console errors, no sideways scrolling');
  process.exitCode = problems.length ? 1 : 0;
}
