// Builds the Laris logo files (SVG, PNG, ICO) into brand/ (docs/identity.md).
// Run once: npm install here and in tools/browser; then: npm run build.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

// Version B on the 64 grid: three units and the base, status lights on the right.
const unit = (x, y, w, h, dot, r = 2) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1-${r} ${r}H${x + r}a${r} ${r} 0 0 1-${r}-${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r}-${r}Z` +
  `M${dot[0] - 1.8} ${dot[1]}a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0Z`;
const MARK_D =
  unit(12, 13, 17, 9, [23.5, 17.5]) +
  unit(12, 25, 17, 9, [23.5, 29.5]) +
  unit(12, 37, 17, 9, [23.5, 41.5]) +
  unit(12, 49, 40, 9, [46.5, 53.5]);
const markPath = (fill) => `<path fill-rule="evenodd" fill="${fill}" d="${MARK_D}"/>`;

// The small-size version, drawn on the 16-pixel grid: whole-pixel bars, no lights (they can't exist at 16 px).
// Each light is a one-pixel notch near the right end of its bar.
const SMALL_D =
  'M3 2h4v2H3zM8 2h1v2H8zM3 5h4v2H3zM8 5h1v2H8zM3 8h4v2H3zM8 8h1v2H8zM3 11h8v3H3zM12 11h1v3h-1z';

const svg = (viewBox, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}">\n<title>${title}</title>\n${body}\n</svg>\n`;

// The wordmark, outlined from IBM Plex Sans SemiBold, its capital height equal to the mark's height (45).
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
const MARK_H = 45; // the mark's content runs from y 13 to 58
const fontSize = MARK_H / capHeight;
const GAP = 17;
const textX = 40 + GAP; // the mark's content is 40 wide
const word = font.getPath('Laris', textX, MARK_H, fontSize);
const wordD = word.toPathData(2);
const wordBox = word.getBoundingBox();
const lockupW = Math.ceil(wordBox.x2 + 1);
const lockup = (markFill, textFill, title) =>
  svg(
    `0 0 ${lockupW} ${MARK_H}`,
    `<g transform="translate(-12 -13)">${markPath(markFill)}</g>\n<path fill="${textFill}" d="${wordD}"/>`,
    title,
  );

// The app icon: the mark in white on an Indigo violet tile.
const tile = (rx = 15) => `<rect width="64" height="64" rx="${rx}" fill="${COLOR.primary}"/>`;
const centred = (scale) =>
  `translate(${(32 - 32 * scale + 1).toFixed(2)} ${(32 - 35.5 * scale).toFixed(2)}) scale(${scale})`;
const appIcon = tile() + `<g transform="${centred(0.8)}">${markPath(COLOR.onPrimary)}</g>`;
// Maskable (Android): a full square; the mark stays inside the central safe zone (80 %).
const maskable = `<rect width="64" height="64" fill="${COLOR.primary}"/><g transform="${centred(0.68)}">${markPath(COLOR.onPrimary)}</g>`;
const favicon = `<rect width="16" height="16" rx="3.5" fill="${COLOR.primary}"/><path fill="${COLOR.onPrimary}" d="${SMALL_D}"/>`;

const files = {
  'laris-logo.svg': lockup(COLOR.primary, COLOR.text, 'Laris'),
  'laris-logo-dark.svg': lockup(COLOR.primaryDark, COLOR.textDark, 'Laris'),
  'laris-logo-black.svg': lockup('#000000', '#000000', 'Laris'),
  'laris-logo-white.svg': lockup('#ffffff', '#ffffff', 'Laris'),
  'laris-mark.svg': svg('0 0 64 64', markPath(COLOR.primary), 'Laris'),
  'laris-mark-dark.svg': svg('0 0 64 64', markPath(COLOR.primaryDark), 'Laris'),
  'laris-mark-black.svg': svg('0 0 64 64', markPath('#000000'), 'Laris'),
  'laris-mark-white.svg': svg('0 0 64 64', markPath('#ffffff'), 'Laris'),
  'laris-app-icon.svg': svg('0 0 64 64', appIcon, 'Laris'),
  'favicon.svg': svg('0 0 16 16', favicon, 'Laris'),
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
const iconSvg = files['laris-app-icon.svg'];
await png(iconSvg, 180, 'apple-touch-icon.png');
await png(iconSvg, 192, 'icon-192.png');
await png(iconSvg, 512, 'icon-512.png');
await png(svg('0 0 64 64', maskable, 'Laris'), 512, 'icon-maskable-512.png');
await png(iconSvg, 500, 'laris-avatar.png');

// favicon.ico: 16 and 32 from the small-size version (exactly 1× and 2× its grid), 48 from the app icon.
const ico16 = await png(files['favicon.svg'], 16);
const ico32 = await png(files['favicon.svg'], 32);
const ico48 = await png(iconSvg, 48);
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
