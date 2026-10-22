import { stubLocalStorage } from '../../layout/testing';
import { readStored, writeStored } from './browser-storage';

describe('browser storage', () => {
  let stub: ReturnType<typeof stubLocalStorage> | undefined;
  afterEach(() => stub?.restore());

  it('reads back what was written', () => {
    stub = stubLocalStorage();
    writeStored(window, 'laris.test', 'dark');
    expect(readStored(window, 'laris.test')).toBe('dark');
    expect(readStored(window, 'laris.missing')).toBeNull();
  });

  it('never throws when reading or writing is refused', () => {
    stub = stubLocalStorage({ blocked: true });
    expect(readStored(window, 'laris.test')).toBeNull();
    expect(() => writeStored(window, 'laris.test', 'dark')).not.toThrow();
  });

  it('never throws when storage itself is refused', () => {
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
