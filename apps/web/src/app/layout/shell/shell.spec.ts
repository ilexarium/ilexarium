import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, TitleStrategy } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of } from 'rxjs';
import { AuthStore } from '../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../core/auth/testing';
import { MonitoringApi } from '../../core/monitoring/monitoring-api';
import { PageTitleStrategy } from '../../core/page-title/page-title';
import { fakeSockets } from '../../core/realtime/testing';
import { LANGUAGE_STORAGE_KEY } from '../../core/i18n/language.constants';
import { stubLocalStorage, stubScreenWidth } from '../testing';
import { Shell } from './shell';

@Component({ template: '<p>page content</p>' })
class Page {}

async function render(url = '/') {
  const fake = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const host = vi.fn(() =>
    of({
      hostname: 'box',
      os: 'Debian GNU/Linux 13',
      kernel: '6.12.48-1-amd64',
      arch: 'x64',
      cpuModel: null,
      cpuCores: 4,
    }),
  );
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: '',
          component: Shell,
          children: [
            { path: '', title: 'pages.dashboard', component: Page },
            { path: 'containers', title: 'pages.containers', component: Page },
            { path: 'containers/:name/logs', title: 'pages.logs', component: Page },
            { path: 'settings/notifications', title: 'pages.notifications', component: Page },
          ],
        },
      ]),
      { provide: TitleStrategy, useExisting: PageTitleStrategy },
      fake.provider,
      sockets.provider,
      { provide: MonitoringApi, useValue: { host } },
    ],
  });
  await TestBed.inject(AuthStore).load();
  const harness = await RouterTestingHarness.create(url);
  const el = harness.fixture.nativeElement as HTMLElement;
  return {
    harness,
    el,
    sockets,
    host,
    navLink: (label: string) =>
      [...el.querySelectorAll<HTMLAnchorElement>('nav a')].find(
        (a) => a.textContent?.trim() === label,
      ),
    sidebarState: () => el.querySelector('hlm-sidebar')!.getAttribute('data-state'),
    trigger: () => el.querySelector<HTMLButtonElement>('button[hlmSidebarTrigger]')!,
  };
}

describe('Shell (app layout)', () => {
  it('asks once for the machine, for the kernel in the top bar', async () => {
    const { host } = await render();
    expect(host).toHaveBeenCalledTimes(1);
  });

  let restoreScreen: (() => void) | null = null;
  let storage: ReturnType<typeof stubLocalStorage>;

  beforeEach(() => {
    storage = stubLocalStorage();
  });
  afterEach(() => {
    restoreScreen?.();
    restoreScreen = null;
    storage.restore();
  });

  it('lists the existing pages in a labelled navigation, grouped', async () => {
    const { el, navLink } = await render();
    const nav = el.querySelector('nav')!;
    expect(nav.getAttribute('aria-label')).toBe('Main');
    expect(navLink('Dashboard')!.getAttribute('href')).toBe('/');
    expect(navLink('Containers')!.getAttribute('href')).toBe('/containers');
    expect(navLink('Apps')!.getAttribute('href')).toBe('/apps');
    expect(navLink('Notifications')!.getAttribute('href')).toBe('/settings/notifications');
    expect(nav.textContent).toContain('Settings');
    const order = [...nav.querySelectorAll('a')].map((a) => a.textContent!.trim());
    expect(order).toEqual([
      'Dashboard',
      'Containers',
      'Apps',
      'Backups',
      'Alerts',
      'Disks',
      'Processes',
      'Services',
      'Logs',
      'Files',
      'Terminal',
      'Notifications',
    ]);
    expect(nav.textContent).toContain('Storage');
  });

  it('marks only the current page, also for the dashboard at "/"', async () => {
    const { harness, navLink } = await render('/');
    expect(navLink('Dashboard')!.getAttribute('aria-current')).toBe('page');
    expect(navLink('Notifications')!.hasAttribute('aria-current')).toBe(false);

    await harness.navigateByUrl('/settings/notifications');
    expect(navLink('Notifications')!.getAttribute('aria-current')).toBe('page');
    expect(navLink('Dashboard')!.hasAttribute('aria-current')).toBe(false);
  });

  it('keeps Containers marked on its sub-pages (a container’s logs)', async () => {
    const { harness, navLink } = await render('/containers');
    expect(navLink('Containers')!.getAttribute('aria-current')).toBe('page');
    await harness.navigateByUrl('/containers/jellyfin/logs');
    expect(navLink('Containers')!.getAttribute('aria-current')).toBe('page');
    expect(navLink('Dashboard')!.hasAttribute('aria-current')).toBe(false);
  });

  it("shows the route's title as the page heading in the top bar", async () => {
    const { harness, el } = await render('/');
    expect(el.querySelector('h1')!.textContent?.trim()).toBe('Dashboard');
    await harness.navigateByUrl('/settings/notifications');
    expect(el.querySelector('h1')!.textContent?.trim()).toBe('Notifications');
    expect(el.querySelectorAll('h1')).toHaveLength(1);
  });

  it('opens the app WebSocket and shows its status in the top bar', async () => {
    const { harness, el, sockets } = await render();
    expect(sockets.sockets).toHaveLength(1);
    expect(el.querySelector('laris-connection-status')!.textContent).toContain('Connecting');
    sockets.latest().open();
    await harness.fixture.whenStable();
    expect(el.querySelector('laris-connection-status')!.textContent).toContain('Live');
  });

  it('holds the one prompt for the Linux account’s sudo password, for any page', async () => {
    const { el } = await render();
    expect(el.querySelectorAll('laris-sudo-dialog')).toHaveLength(1);
  });

  it('renders the routed page and the user menu', async () => {
    const { el } = await render();
    expect(el.textContent).toContain('page content');
    const menu = el.querySelector('button[aria-label="Account menu"]')!;
    expect(menu.textContent).toContain('OW');
  });

  describe('sidebar state', () => {
    it('is expanded on large screens and collapses to icons when toggled, remembering it', async () => {
      restoreScreen = stubScreenWidth(1280);
      const { harness, sidebarState, trigger } = await render();
      expect(sidebarState()).toBe('expanded');
      trigger().click();
      await harness.fixture.whenStable();
      expect(sidebarState()).toBe('collapsed');
      expect(storage.storage.getItem('laris.sidebar')).toBe('false');
    });

    it('starts collapsed to icons on medium screens', async () => {
      restoreScreen = stubScreenWidth(900);
      const { sidebarState } = await render();
      expect(sidebarState()).toBe('collapsed');
    });

    it('keeps a remembered choice over the screen size', async () => {
      restoreScreen = stubScreenWidth(900);
      storage.storage.setItem('laris.sidebar', 'true');
      const { sidebarState } = await render();
      expect(sidebarState()).toBe('expanded');
    });

    it('works without storage (blocked or private mode)', async () => {
      restoreScreen = stubScreenWidth(1280);
      storage.restore();
      storage = stubLocalStorage({ blocked: true });
      const { harness, sidebarState, trigger } = await render();
      trigger().click();
      await harness.fixture.whenStable();
      expect(sidebarState()).toBe('collapsed');
    });
  });

  describe('on phones', () => {
    it('makes the navigation items taller in the phone sheet (a dense list of touch targets)', async () => {
      restoreScreen = stubScreenWidth(400);
      const { harness, trigger } = await render();
      trigger().click();
      await harness.fixture.whenStable();
      const links = document.querySelectorAll('[data-mobile="true"] nav a');
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(link.className).toContain('max-md:h-11');
    });

    it('hides the navigation in a sheet that the menu button opens, and a choice closes it', async () => {
      restoreScreen = stubScreenWidth(400);
      const { harness, el, trigger } = await render();
      await harness.fixture.whenStable();
      expect(el.querySelector('nav')).toBeNull();

      trigger().click();
      await harness.fixture.whenStable();
      const sheetNav = document.querySelector<HTMLElement>('[data-mobile="true"] nav');
      expect(sheetNav).not.toBeNull();

      const notifications = [...sheetNav!.querySelectorAll<HTMLAnchorElement>('a')].find(
        (a) => a.textContent?.trim() === 'Notifications',
      )!;
      notifications.click();
      await harness.fixture.whenStable();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-mobile="true"][data-state="open"]')).toBeNull(),
      );
      expect(el.querySelector('h1')!.textContent?.trim()).toBe('Notifications');
    });
  });

  describe('right to left (Arabic)', () => {
    beforeEach(() => storage.storage.setItem(LANGUAGE_STORAGE_KEY, 'ar'));
    afterEach(() => {
      document.documentElement.dir = '';
      document.documentElement.lang = '';
    });

    it('mirrors the layout on large screens: the sidebar sits on the right', async () => {
      restoreScreen = stubScreenWidth(1280);
      const { harness, el } = await render();
      await harness.fixture.whenStable();
      expect(document.documentElement.dir).toBe('rtl');
      expect(el.querySelector('hlm-sidebar')!.getAttribute('data-side')).toBe('right');
      // The sidebar icon points the other way too.
      const icon = el.querySelector('button[hlmSidebarTrigger] ng-icon')!;
      expect(icon.className).toContain('rtl:-scale-x-100');
    });

    it('slides the phone sheet in from the right', async () => {
      restoreScreen = stubScreenWidth(400);
      const { harness, trigger } = await render();
      await harness.fixture.whenStable();
      trigger().click();
      await harness.fixture.whenStable();
      const sheet = document.querySelector('hlm-sheet-content[data-side]');
      expect(sheet?.getAttribute('data-side')).toBe('right');
      document.querySelectorAll('.cdk-overlay-container').forEach((node) => node.remove());
    });

    it('stays left to right in English', async () => {
      storage.storage.setItem(LANGUAGE_STORAGE_KEY, 'en');
      restoreScreen = stubScreenWidth(1280);
      const { harness, el } = await render();
      await harness.fixture.whenStable();
      expect(document.documentElement.dir).toBe('ltr');
      expect(el.querySelector('hlm-sidebar')!.getAttribute('data-side')).toBe('left');
    });
  });
});
