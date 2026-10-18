import {
  FONT_WAIT_MS,
  SYMBOLS_FONT_FAMILY,
  SYMBOLS_FONT_URL,
  TERMINAL_FONT_SIZE,
} from './terminal-view.constants';

let symbols: FontFace | null = null;

/**
 * Loads the terminal's fonts before xterm measures its cells (a font arriving later would change
 * the cell size). The symbols font is registered here, not in the app's styles, so only the
 * Terminal page downloads it. Waits at most `FONT_WAIT_MS` (the terminal's ticket is short-lived)
 * and never fails: without the fonts the terminal uses the fallbacks. A symbols font that failed
 * to load is tried again the next time.
 */
export async function loadTerminalFonts(document: Document): Promise<void> {
  const fonts = document.fonts as FontFaceSet | undefined;
  if (!fonts || typeof FontFace !== 'function') return;
  if (symbols?.status === 'error') {
    fonts.delete(symbols);
    symbols = null;
  }
  if (!symbols) {
    symbols = new FontFace(SYMBOLS_FONT_FAMILY, `url(${SYMBOLS_FONT_URL}) format('woff2')`);
    fonts.add(symbols);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([
      fonts.load(`${TERMINAL_FONT_SIZE}px 'JetBrains Mono'`),
      fonts.load(`600 ${TERMINAL_FONT_SIZE}px 'JetBrains Mono'`),
      symbols.load(),
    ]),
    new Promise((resolve) => (timer = setTimeout(resolve, FONT_WAIT_MS))),
  ]);
  clearTimeout(timer);
}
