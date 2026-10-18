// Builds the terminal's fallback font for icons (docs/identity.md, Typography): Symbols Nerd Font
// Mono from the Nerd Fonts release, cut down to the icon sets prompts use, as WOFF2 in
// apps/web/public/fonts/. Run once: npm install here; then: npm run build (needs tar with xz).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import subsetFont from 'subset-font';

const VERSION = '3.5.1';
const ARCHIVE = `https://github.com/ryanoasis/nerd-fonts/releases/download/v${VERSION}/NerdFontsSymbolsOnly.tar.xz`;
// From the release's SHA-256.txt.
const SHA256 = '01172f37db8543edb102e5cb5c64101c9f4686630804d49b419aa07b23a69996';
const OUT = new URL('../../apps/web/public/fonts/', import.meta.url).pathname;

// Nerd Fonts 3 code points (github.com/ryanoasis/nerd-fonts/wiki/Glyph-Sets-and-Code-Points): the
// sets prompts use most, small enough to load with the page. Devicons, Codicons, all of Font
// Awesome and Material Design (most of the font's size) stay out.
const RANGES = [
  [0xe0a0, 0xe0a3], // Powerline: branch, line number, lock
  [0xe0b0, 0xe0d7], // Powerline and Powerline Extra: the segment arrows and shapes
  [0xe5fa, 0xe6b7], // Seti-UI: file type icons
  [0xf300, 0xf381], // Font Logos: distribution logos
  [0xf400, 0xf533], // Octicons: git branch, commit, diff; folders, files
];
// Font Awesome: user, home, clock, lock, folder, folder open, GitHub, Apple, Windows, Linux, git.
const SINGLES = [
  0xf007, 0xf015, 0xf017, 0xf023, 0xf07b, 0xf07c, 0xf09b, 0xf179, 0xf17a, 0xf17c, 0xf1d3,
];

const response = await fetch(ARCHIVE);
if (!response.ok) throw new Error(`${ARCHIVE}: ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const sum = createHash('sha256').update(archive).digest('hex');
if (sum !== SHA256) throw new Error(`checksum mismatch: ${sum}`);

const dir = mkdtempSync(join(tmpdir(), 'nerd-fonts-'));
try {
  writeFileSync(join(dir, 'symbols.tar.xz'), archive);
  execFileSync('tar', ['-xJf', 'symbols.tar.xz'], { cwd: dir });
  const font = readFileSync(join(dir, 'SymbolsNerdFontMono-Regular.ttf'));
  const text = [
    ...RANGES.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i)),
    ...SINGLES,
  ]
    .map((code) => String.fromCodePoint(code))
    .join('');
  const woff2 = await subsetFont(font, text, { targetFormat: 'woff2' });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `symbols-nerd-font-mono-${VERSION}.woff2`), woff2);
  writeFileSync(join(OUT, 'SYMBOLS-NERD-FONT-LICENSE'), readFileSync(join(dir, 'LICENSE')));
  console.log(`symbols-nerd-font-mono-${VERSION}.woff2: ${(woff2.length / 1024).toFixed(0)} KiB`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
