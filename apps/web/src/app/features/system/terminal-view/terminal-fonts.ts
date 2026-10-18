import {
  SYMBOLS_FONT_FAMILY,
  SYMBOLS_FONT_URL,
  TERMINAL_FONT_SIZE,
} from './terminal-view.constants';

let symbols: FontFace | null = null;

/**
 * Loads the terminal's fonts before xterm measures its cells (a font arriving later would change
 * the cell size). The symbols font is registered here, not in the app's styles, so only the
 * Terminal page downloads it. Never fails: without the fonts the terminal uses the fallbacks.
 */
export async function loadTerminalFonts(document: Document): Promise<void> {
  const fonts = document.fonts as FontFaceSet | undefined;
  if (!fonts || typeof FontFace !== 'function') return;
  if (!symbols) {
    symbols = new FontFace(SYMBOLS_FONT_FAMILY, `url(${SYMBOLS_FONT_URL}) format('woff2')`);
    fonts.add(symbols);
  }
  await Promise.allSettled([
    fonts.load(`${TERMINAL_FONT_SIZE}px 'JetBrains Mono'`),
    fonts.load(`600 ${TERMINAL_FONT_SIZE}px 'JetBrains Mono'`),
    symbols.load(),
  ]);
}
