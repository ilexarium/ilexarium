import type { ITheme } from '@xterm/xterm';

/** The icon font (Nerd Font symbols subset, built by `tools/fonts/`), loaded only with the terminal. */
export const SYMBOLS_FONT_FAMILY = 'Symbols Nerd Font Mono';
export const SYMBOLS_FONT_URL = 'fonts/symbols-nerd-font-mono-3.5.1.woff2';

/** JetBrains Mono (bundled with the app) for text, the symbols for the icons prompts draw. */
export const TERMINAL_FONT_FAMILY = `'JetBrains Mono', '${SYMBOLS_FONT_FAMILY}', ui-monospace, monospace`;
export const TERMINAL_FONT_SIZE = 14;
/** How long the terminal waits for its fonts before opening with the fallbacks. */
export const FONT_WAIT_MS = 2000;

/** Fixed palettes (xterm needs plain colours; the app's tokens are oklch): the theme's text and primary as hex. */
export const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#151628',
  cursor: '#544ccb',
  selectionBackground: '#d5daff',
};
export const DARK: ITheme = {
  background: '#0d0e16',
  foreground: '#f2f3f9',
  cursor: '#a8afff',
  selectionBackground: '#353766',
};

/** What the phone key bar's keys send. */
export const KEYS = {
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
} as const;
