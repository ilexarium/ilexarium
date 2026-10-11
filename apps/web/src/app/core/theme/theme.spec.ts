import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { stubLocalStorage } from '../../layout/testing';
import { THEME_STORAGE_KEY, ThemeService } from './theme';

/** A device whose light/dark setting the test can flip. */
function stubSystemTheme(initiallyDark: boolean) {
  let listener: ((event: { matches: boolean }) => void) | null = null;
  const media = {
    matches: initiallyDark,
    addEventListener: (_: string, fn: typeof listener) => (listener = fn),
    removeEventListener: () => (listener = null),
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => media });
  return {
    setDark(dark: boolean) {
      media.matches = dark;
      listener?.({ matches: dark });
    },
    restore: () => delete (window as { matchMedia?: unknown }).matchMedia,
  };
}

const isDark = () => document.documentElement.classList.contains('dark');

describe('ThemeService', () => {
  let storage: ReturnType<typeof stubLocalStorage>;
  let system: ReturnType<typeof stubSystemTheme>;

  beforeEach(() => {
    storage = stubLocalStorage();
    system = stubSystemTheme(false);
  });
  afterEach(() => {
    storage.restore();
    system.restore();
    document.documentElement.classList.remove('dark');
  });

  function create() {
    const theme = TestBed.inject(ThemeService);
    TestBed.tick();
    return theme;
  }

  it('follows the device by default, live', () => {
    system.restore();
    system = stubSystemTheme(true);
    const theme = create();
    expect(theme.choice()).toBe('system');
    expect(isDark()).toBe(true);
    system.setDark(false);
    TestBed.tick();
    expect(isDark()).toBe(false);
  });

  it('applies and remembers an explicit choice, regardless of the device', () => {
    const theme = create();
    theme.setChoice('dark');
    TestBed.tick();
    expect(isDark()).toBe(true);
    expect(storage.storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    system.setDark(false);
    TestBed.tick();
    expect(isDark()).toBe(true);

    theme.setChoice('light');
    system.setDark(true);
    TestBed.tick();
    expect(isDark()).toBe(false);
  });

  it('starts from the remembered choice, ignoring anything unknown', () => {
    storage.storage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(create().choice()).toBe('dark');
    TestBed.resetTestingModule();
    storage.storage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(create().choice()).toBe('system');
  });

  it('works with storage blocked', () => {
    storage.restore();
    storage = stubLocalStorage({ blocked: true });
    const theme = create();
    expect(theme.choice()).toBe('system');
    theme.setChoice('dark');
    TestBed.tick();
    expect(isDark()).toBe(true);
  });
});

describe('theme-init.js (runs before the app)', () => {
  const script = readFileSync(resolve(process.cwd(), 'public/theme-init.js'), 'utf8');
  let storage: ReturnType<typeof stubLocalStorage>;
  let system: ReturnType<typeof stubSystemTheme>;

  afterEach(() => {
    storage.restore();
    system.restore();
    document.documentElement.classList.remove('dark');
  });

  function run(stored: string | null, deviceDark: boolean, blocked = false) {
    storage = stubLocalStorage({ blocked });
    if (stored && !blocked) storage.storage.setItem(THEME_STORAGE_KEY, stored);
    system = stubSystemTheme(deviceDark);
    new Function(script)();
    return isDark();
  }

  it('makes the same decision as ThemeService', () => {
    expect(run(null, true)).toBe(true);
    expect(run(null, false)).toBe(false);
    expect(run('system', true)).toBe(true);
    expect(run('dark', false)).toBe(true);
    expect(run('light', true)).toBe(false);
    expect(run(null, true, true)).toBe(true); // storage blocked: follows the device
  });
});
