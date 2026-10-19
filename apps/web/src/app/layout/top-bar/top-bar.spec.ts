import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Language } from '@homelab/i18n';
import { AlertsStore } from '../../core/alerts/alerts-store';
import { alertsStatus, testAlert } from '../../core/alerts/testing';
import { AuthStore } from '../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../core/auth/testing';
import { LanguageService } from '../../core/i18n/language';
import { TopBar } from './top-bar';

/** Stands in for the language service with all three languages available. */
function fakeLanguages() {
  const language = signal<Language>('en');
  return {
    language: language.asReadonly(),
    available: ['en', 'de', 'ar'] as Language[],
    setLanguage: vi.fn(async (next: Language) => language.set(next)),
  };
}

describe('TopBar user menu', () => {
  let languages: ReturnType<typeof fakeLanguages>;

  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()));

  async function openMenu() {
    languages = fakeLanguages();
    const auth = fakeAuthApi({ user: OWNER });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        auth.provider,
        { provide: LanguageService, useValue: languages },
      ],
    });
    await TestBed.inject(AuthStore).load();
    const fixture = TestBed.createComponent(TopBar);
    await fixture.whenStable();
    const trigger = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[aria-label="Account menu"]',
    )!;
    trigger.click();
    await fixture.whenStable();
    const radios = () => [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ];
    return { fixture, trigger, radios };
  }

  it('offers each language under its own name, marked with its language, the current one checked', async () => {
    const { radios } = await openMenu();
    expect(document.body.textContent).toContain('Language');
    expect(radios().map((item) => item.textContent!.trim())).toEqual([
      'English',
      'Deutsch',
      'العربية',
    ]);
    expect(radios().map((item) => item.getAttribute('lang'))).toEqual(['en', 'de', 'ar']);
    expect(radios().map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  it('switches the language, and shows the new choice next time', async () => {
    const { fixture, trigger, radios } = await openMenu();
    radios()[1].click();
    await fixture.whenStable();
    expect(languages.setLanguage).toHaveBeenCalledWith('de');

    trigger.click();
    await fixture.whenStable();
    expect(radios().map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it('still has Change password and Sign out', async () => {
    await openMenu();
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
      item.textContent!.trim(),
    );
    expect(items).toEqual(['Change password', 'Sign out']);
  });
});

describe('TopBar alerts bell', () => {
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()));

  it('shows the open alerts on the bell, which opens the alerts menu', async () => {
    const auth = fakeAuthApi({ user: OWNER });
    TestBed.configureTestingModule({ providers: [provideRouter([]), auth.provider] });
    await TestBed.inject(AuthStore).load();
    const fixture = TestBed.createComponent(TopBar);
    TestBed.inject(AlertsStore).fill(
      alertsStatus({ open: [testAlert({ severity: 'warning' }), testAlert()] }),
    );
    await fixture.whenStable();
    const bell = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'app-alerts-menu button',
    )!;
    expect(bell.getAttribute('aria-label')).toBe('Alerts: 2 open');
    bell.click();
    await fixture.whenStable();
    expect(document.querySelector('[data-slot="dropdown-menu"]')!.textContent).toContain('Immich');
  });
});
