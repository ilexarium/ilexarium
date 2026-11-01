import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { testTemplate } from '../../../core/apps/testing';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { BackupsApi } from '../../../core/backups/backups-api';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { NewAppPage } from './new-app-page';

async function render() {
  const auth = fakeAuthApi({ user: OWNER });
  const appsApi = {
    templates: vi.fn(() =>
      of([
        testTemplate('navidrome', { name: 'Navidrome' }),
        testTemplate('immich', { name: 'Immich' }),
      ]),
    ),
    checkName: vi.fn((name: string) => of({ free: true, suggestion: name })),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      { provide: AppsApi, useValue: appsApi },
      { provide: BackupsApi, useValue: {} },
      {
        provide: LinuxSessionStore,
        useValue: { check: vi.fn(), session: () => ({ username: 'anna' }) },
      },
    ],
  });
  await TestBed.inject(AuthStore).load();
  const fixture = TestBed.createComponent(NewAppPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { el, settle: () => fixture.whenStable() };
}

describe('NewAppPage', () => {
  it('offers a tile per template and, last, a dashed one for your own Compose file — no search for a few', async () => {
    const { el } = await render();
    const tiles = [...el.querySelectorAll('button[data-template]')].map((t) => t.textContent!);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toContain('Navidrome');
    const own = el.querySelector<HTMLElement>('button[data-own-file]')!;
    expect(own.closest('li')!.matches(':last-child')).toBe(true);
    expect(own.className).toContain('border-dashed');
    expect(el.querySelector('input[type="search"]')).toBeNull();
    // The paste box is no longer on the first screen.
    expect(el.querySelector('textarea')).toBeNull();
  });

  it('your own file: set up with its Files open; a summary beside it on desktop, Install in a bar on phones', async () => {
    const { el, settle } = await render();
    el.querySelector<HTMLButtonElement>('button[data-own-file]')!.click();
    await vi.waitFor(async () => {
      await settle();
      expect(el.querySelector('#app-name')).not.toBeNull();
    });
    expect(el.querySelector<HTMLDetailsElement>('details')!.open).toBe(true);
    expect(el.querySelector('#compose-file')).not.toBeNull();
    const summary = el.querySelector<HTMLElement>('aside')!;
    expect(summary.className).toContain('hidden lg:block');
    expect(summary.textContent).toContain('anna');
    expect(summary.textContent).toContain('~/apps/app');
    const bar = el.querySelector<HTMLElement>('[data-install-bar]')!;
    expect(bar.className).toContain('sticky bottom-0');
    expect(bar.className).toContain('lg:hidden');
    // Nothing to install before there's a file.
    expect(bar.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  });
});
