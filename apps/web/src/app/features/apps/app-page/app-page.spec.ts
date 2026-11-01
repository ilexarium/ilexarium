import { Component } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { testContainer, testDetails } from '../../../core/apps/testing';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { BackupsApi } from '../../../core/backups/backups-api';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { AppPage } from './app-page';

@Component({ template: '' })
class Elsewhere {}

async function setup({ signedIn = true } = {}) {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const appsApi = {
    templates: vi.fn(() => of([])),
    details: vi.fn(() =>
      signedIn
        ? of(testDetails('music'))
        : throwError(
            () =>
              new HttpErrorResponse({
                status: 403,
                error: { message: 'x', code: 'linux_session_required' },
              }),
          ),
    ),
    task: vi.fn(() => of({ task: null })),
    removal: vi.fn(() => of({ items: [] })),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'apps', component: Elsewhere },
        { path: 'apps/:name', component: AppPage },
        { path: 'containers/:name/logs', component: Elsewhere },
      ]),
      auth.provider,
      sockets.provider,
      { provide: AppsApi, useValue: appsApi },
      { provide: BackupsApi, useValue: {} },
      {
        provide: LinuxSessionStore,
        useValue: { asPerson: vi.fn((action: () => unknown) => action()), check: vi.fn() },
      },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const harness = await RouterTestingHarness.create();
  const visit = async (url: string) => {
    await harness.navigateByUrl(url);
    await harness.fixture.whenStable();
    return harness.routeNativeElement!;
  };
  const el = await visit('/apps/music');
  socket.receive({
    event: 'containers:snapshot',
    data: {
      dockerAvailable: true,
      containers: [testContainer('music-web-1', 'music'), testContainer('other-1', 'other')],
      history: {},
    },
  });
  await harness.fixture.whenStable();
  const settle = () => harness.fixture.whenStable();
  return { el, appsApi, harness, settle, visit, router: TestBed.inject(Router) };
}

const trigger = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) =>
    tab.textContent!.includes(name),
  )!;
const panel = (el: HTMLElement) => el.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');

describe('AppPage', () => {
  it('opens on Overview: its header, its own containers with a link to their logs', async () => {
    const { el } = await setup();
    expect(el.querySelector('laris-app-header h2')!.textContent).toContain('music');
    expect(trigger(el, 'Overview').getAttribute('aria-selected')).toBe('true');
    const overview = panel(el)!;
    expect(overview.textContent).toContain('music-web-1');
    expect(overview.textContent).not.toContain('other-1');
    expect(overview.querySelector('a[href="/containers/music-web-1/logs"]')).not.toBeNull();
    expect(overview.textContent).toContain('Update');
  });

  it('keeps the tab in the URL, without reading the app again', async () => {
    const { el, appsApi, router, settle, visit } = await setup();
    trigger(el, 'Settings').click();
    await settle();
    expect(router.url).toBe('/apps/music?tab=settings');
    expect(panel(el)!.querySelector('#compose-file')).not.toBeNull();
    expect(appsApi.details).toHaveBeenCalledTimes(1);
    trigger(el, 'Overview').click();
    await settle();
    expect(router.url).toBe('/apps/music');
    // Straight to a tab from its link.
    const again = await visit('/apps/music?tab=settings');
    expect(trigger(again, 'Settings').getAttribute('aria-selected')).toBe('true');
  });

  it('shows the save bar only while there are changes; Discard takes it away', async () => {
    const { visit, settle } = await setup();
    const el = await visit('/apps/music?tab=settings');
    expect(el.querySelector('[data-save-bar]')).toBeNull();
    const env = el.querySelector<HTMLTextAreaElement>('#env-file')!;
    env.value = 'VERSION=1.28\n';
    env.dispatchEvent(new Event('input'));
    await settle();
    const bar = el.querySelector<HTMLElement>('[data-save-bar]')!;
    expect(bar.className).toContain('sticky bottom-0');
    expect(bar.textContent).toContain('Unsaved changes');
    [...bar.querySelectorAll('button')].find((b) => b.textContent!.includes('Discard'))!.click();
    await vi.waitFor(async () => {
      await settle();
      expect(el.querySelector('[data-save-bar]')).toBeNull();
    });
  });

  it('without a Linux sign-in: the header and the containers still, the sign-in where the files are needed', async () => {
    const { el, settle } = await setup({ signedIn: false });
    expect(el.querySelector('laris-app-header h2')!.textContent).toContain('music');
    // Its folder from Docker's labels.
    expect(el.querySelector('laris-app-header')!.textContent).toContain('~/apps/music');
    expect(panel(el)!.textContent).toContain('music-web-1');
    expect(panel(el)!.querySelector('[role="alert"]')!.textContent).toContain('Sign in');
    trigger(el, 'Settings').click();
    await settle();
    expect(panel(el)!.querySelector('[role="alert"]')!.textContent).toContain('Sign in');
    expect(panel(el)!.querySelector('#compose-file')).toBeNull();
  });

  it('removes from the header’s menu: the dialog opens with its list, Cancel closes it', async () => {
    const { el, appsApi } = await setup();
    el.querySelector<HTMLButtonElement>('button[aria-label="More for music"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    expect(appsApi.removal).toHaveBeenCalledWith('music', '/home/anna/apps/music');
    [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((b) => b.textContent!.includes('Cancel'))!
      .click();
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
  });
});
