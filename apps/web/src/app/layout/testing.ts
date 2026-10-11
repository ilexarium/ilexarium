/**
 * jsdom has no `matchMedia`: pretends the screen is `width` pixels wide for the min-/max-width
 * queries the layout uses. Returns the cleanup.
 */
export function stubScreenWidth(width: number): () => void {
  const matchMedia = (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
  return () => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  };
}

/**
 * An in-memory `localStorage` (this test setup's jsdom has none). `blocked` makes every access
 * throw, like a browser with storage disabled. Returns the store and the cleanup.
 */
export function stubLocalStorage({ blocked = false } = {}) {
  const items = new Map<string, string>();
  const guard = () => {
    if (blocked) throw new DOMException('Storage is disabled', 'SecurityError');
  };
  const storage = {
    getItem: (key: string) => (guard(), items.get(key) ?? null),
    setItem: (key: string, value: string) => (guard(), void items.set(key, String(value))),
    removeItem: (key: string) => (guard(), void items.delete(key)),
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  return {
    storage,
    restore: () => {
      delete (window as { localStorage?: unknown }).localStorage;
    },
  };
}
