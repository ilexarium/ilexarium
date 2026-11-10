import { stubLocalStorage } from '../../layout/testing';
import { readStored, writeStored } from './browser-storage';

describe('browser storage', () => {
  let stub: ReturnType<typeof stubLocalStorage> | undefined;
  afterEach(() => stub?.restore());

  it('reads back what was written', () => {
    stub = stubLocalStorage();
    writeStored(window, 'ilex.test', 'dark');
    expect(readStored(window, 'ilex.test')).toBe('dark');
    expect(readStored(window, 'ilex.missing')).toBeNull();
  });

  it('never throws when reading or writing is refused', () => {
    stub = stubLocalStorage({ blocked: true });
    expect(readStored(window, 'ilex.test')).toBeNull();
    expect(() => writeStored(window, 'ilex.test', 'dark')).not.toThrow();
  });

  it('never throws when storage itself is refused', () => {
    const blocked = {
      get localStorage(): Storage {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as Window;
    expect(readStored(blocked, 'ilex.test')).toBeNull();
    expect(() => writeStored(blocked, 'ilex.test', 'dark')).not.toThrow();
  });

  it('does nothing without a window', () => {
    expect(readStored(null, 'ilex.test')).toBeNull();
    expect(() => writeStored(null, 'ilex.test', 'dark')).not.toThrow();
  });
});
