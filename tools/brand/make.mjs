// Builds the Ilexarium logo files (SVG, PNG, ICO) into brand/.
// Run once: npm install here and in tools/browser; then: npm run build.
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const opentype = require('opentype.js');
const { chromium } = await import(
  new URL('../browser/node_modules/playwright/index.mjs', import.meta.url).href
);

const OUT = new URL('../../brand/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const COLOR = {
  primary: '#544ccb', // Indigo violet, light
  primaryDark: '#a8afff', // Indigo violet, dark (lavender)
  text: '#151628',
  textDark: '#f2f3f9',
  onPrimary: '#f8faff',
};

// On the 64 grid: a terminal screen with its top corner cut, a prompt cut out of it, on two server
// units with their status lights. The cut corner is the mark's signature: every version keeps it.
const unit = (x, y, w, h, dot, r = 2) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1-${r} ${r}H${x + r}a${r} ${r} 0 0 1-${r}-${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r}-${r}Z` +
  `M${dot[0] - 1.8} ${dot[1]}a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0Z`;
const SCREEN = 'M15 12H42L52 22V28a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3Z';
const PROMPT = 'M18 16.5L25.5 21.5L18 26.5V23.4L21.2 21.5L18 19.6ZM28 24h9v2.5h-9Z';
const MARK_D =
  SCREEN + PROMPT + unit(12, 35, 40, 9, [46.5, 39.5]) + unit(12, 47, 40, 9, [46.5, 51.5]);
const markPath = (fill) => `<path fill-rule="evenodd" fill="${fill}" d="${MARK_D}"/>`;

// The small-size version, drawn on the 16-pixel grid because the full mark blurs at 16 px, filling
// it (no tile, like other sites' tab icons): the cut corner kept, the prompt as a one-pixel chevron
// and underscore, each light a notch.
const SMALL_D =
  'M1 1H11L15 5V9H1ZM3 3h1v1H3zM4 4h1v1H4zM3 5h1v1H3zM6 6h3v1H6z' +
  'M1 10h11v2H1zM13 10h2v2h-2zM1 13h11v2H1zM13 13h2v2h-2z';

const svg = (viewBox, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}">\n<title>${title}</title>\n${body}\n</svg>\n`;

// The wordmark, outlined from IBM Plex Sans SemiBold, its capital height equal to the mark's height (44).
const fontFile = readFileSync(
  new URL(
    './node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff',
    import.meta.url,
  ),
);
const font = opentype.parse(
  fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength),
);
const capHeight = font.tables.os2.sCapHeight / font.unitsPerEm;
const MARK_H = 44; // the mark's content runs from y 12 to 56
const fontSize = MARK_H / capHeight;
const GAP = 17;
const textX = 40 + GAP; // the mark's content is 40 wide
const word = font.getPath('Ilexarium', textX, MARK_H, fontSize);
const wordD = word.toPathData(2);
const wordBox = word.getBoundingBox();
const lockupW = Math.ceil(wordBox.x2 + 1);
const lockup = (markFill, textFill, title) =>
  svg(
    `0 0 ${lockupW} ${MARK_H}`,
    `<g transform="translate(-12 -12)">${markPath(markFill)}</g>\n<path fill="${textFill}" d="${wordD}"/>`,
    title,
  );

// The app icon: the mark in white on an Indigo violet tile.
const tile = (rx = 15) => `<rect width="64" height="64" rx="${rx}" fill="${COLOR.primary}"/>`;
const centred = (scale) =>
  `translate(${(32 - 32 * scale).toFixed(2)} ${(32 - 34 * scale).toFixed(2)}) scale(${scale})`;
const appIcon = tile() + `<g transform="${centred(0.8)}">${markPath(COLOR.onPrimary)}</g>`;
// Maskable (Android): a full square; the mark stays inside the central safe zone (80 %).
const maskable = `<rect width="64" height="64" fill="${COLOR.primary}"/><g transform="${centred(0.68)}">${markPath(COLOR.onPrimary)}</g>`;
// Lavender where the browser is dark, so the mark stays visible on a dark tab bar.
const favicon = `<style>path{fill:${COLOR.primary}}@media (prefers-color-scheme:dark){path{fill:${COLOR.primaryDark}}}</style><path fill-rule="evenodd" d="${SMALL_D}"/>`;

const files = {
  'ilexarium-logo.svg': lockup(COLOR.primary, COLOR.text, 'Ilexarium'),
  'ilexarium-logo-dark.svg': lockup(COLOR.primaryDark, COLOR.textDark, 'Ilexarium'),
  'ilexarium-logo-black.svg': lockup('#000000', '#000000', 'Ilexarium'),
  'ilexarium-logo-white.svg': lockup('#ffffff', '#ffffff', 'Ilexarium'),
  'ilexarium-mark.svg': svg('0 0 64 64', markPath(COLOR.primary), 'Ilexarium'),
  'ilexarium-mark-dark.svg': svg('0 0 64 64', markPath(COLOR.primaryDark), 'Ilexarium'),
  'ilexarium-mark-black.svg': svg('0 0 64 64', markPath('#000000'), 'Ilexarium'),
  'ilexarium-mark-white.svg': svg('0 0 64 64', markPath('#ffffff'), 'Ilexarium'),
  'ilexarium-app-icon.svg': svg('0 0 64 64', appIcon, 'Ilexarium'),
  'favicon.svg': svg('0 0 16 16', favicon, 'Ilexarium'),
};
for (const [name, content] of Object.entries(files)) writeFileSync(OUT + name, content);

// PNGs, rendered by the browser at exact pixel sizes with a transparent background.
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(svgText, size, name) {
  const sized = svgText.replace('<svg ', `<svg width="${size}" height="${size}" `);
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${sized}</body></html>`,
  );
  const buffer = await page.screenshot({
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: true,
  });
  if (name) writeFileSync(OUT + name, buffer);
  return buffer;
}
const iconSvg = files['ilexarium-app-icon.svg'];
await png(iconSvg, 180, 'apple-touch-icon.png');
await png(iconSvg, 192, 'icon-192.png');
await png(iconSvg, 512, 'icon-512.png');
await png(svg('0 0 64 64', maskable, 'Ilexarium'), 512, 'icon-maskable-512.png');
await png(iconSvg, 500, 'ilexarium-avatar.png');

// favicon.ico: the small-size version at exactly 1×, 2× and 3× its grid (the ICO has no dark mode: violet).
const ico16 = await png(files['favicon.svg'], 16);
const ico32 = await png(files['favicon.svg'], 32);
const ico48 = await png(files['favicon.svg'], 48);
await browser.close();

// An ICO file holding PNG images: a 6-byte header, a 16-byte entry per image, then the images.
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(([size, data]) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(([, data]) => data)]);
}
writeFileSync(
  OUT + 'favicon.ico',
  ico([
    [16, ico16],
    [32, ico32],
    [48, ico48],
  ]),
);

console.log(
  `capital height ${capHeight.toFixed(3)} em, font size ${fontSize.toFixed(1)}, lockup ${lockupW} × ${MARK_H}`,
);
console.log(Object.keys(files).length + ' SVG files, 5 PNG files, favicon.ico');

// The web app's icons (favicon, home screen, manifest) are copies: its build only takes files from apps/web.
const WEB = new URL('../../apps/web/public/', import.meta.url).pathname;
const WEB_ICONS = [
  'favicon.ico',
  'favicon.svg',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
];
for (const name of WEB_ICONS) copyFileSync(OUT + name, WEB + name);
console.log(`copied ${WEB_ICONS.length} icons to apps/web/public/`);
