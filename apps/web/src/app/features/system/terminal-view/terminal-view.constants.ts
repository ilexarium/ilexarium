/** The icon font (Nerd Font symbols subset, built by `tools/fonts/`), loaded only with the terminal. */
export const SYMBOLS_FONT_FAMILY = 'Symbols Nerd Font Mono';
export const SYMBOLS_FONT_URL = 'fonts/symbols-nerd-font-mono-3.5.1.woff2';

/** JetBrains Mono (bundled with the app) for text, the symbols for the icons prompts draw. */
export const TERMINAL_FONT_FAMILY = `'JetBrains Mono', '${SYMBOLS_FONT_FAMILY}', ui-monospace, monospace`;
export const TERMINAL_FONT_SIZE = 14;
/** How long the terminal waits for its fonts before opening with the fallbacks. */
export const FONT_WAIT_MS = 2000;
