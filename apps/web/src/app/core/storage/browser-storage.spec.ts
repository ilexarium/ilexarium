import { readStored, writeStored } from './browser-storage';

function fakeWindow(): Window {
  const items = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
  return { localStorage } as unknown as Window;
}

describe('browser storage', () => {
  it('reads back what was written', () => {
    const window = fakeWindow();
    writeStored(window, 'laris.test', 'dark');
    expect(readStored(window, 'laris.test')).toBe('dark');
    expect(readStored(window, 'laris.missing')).toBeNull();
  });

  it('never throws when storage is blocked', () => {
    const blocked = {
      get localStorage(): Storage {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as Window;
    expect(readStored(blocked, 'laris.test')).toBeNull();
    expect(() => writeStored(blocked, 'laris.test', 'dark')).not.toThrow();
  });

  it('does nothing without a window', () => {
    expect(readStored(null, 'laris.test')).toBeNull();
    expect(() => writeStored(null, 'laris.test', 'dark')).not.toThrow();
  });
});
