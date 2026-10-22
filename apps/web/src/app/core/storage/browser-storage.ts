// Per-browser preferences only (theme, language, log toggles): storage can be unavailable or
// blocked (private windows, strict settings), and then a choice lasts until the page reloads.

export function readStored(window: Window | null, key: string): string | null {
  try {
    return window?.localStorage.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(window: Window | null, key: string, value: string): void {
  try {
    window?.localStorage.setItem(key, value);
  } catch {
    // Unavailable: see above.
  }
}
