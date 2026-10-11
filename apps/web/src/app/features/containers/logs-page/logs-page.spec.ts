import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, Router, TitleStrategy } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { LogLine } from '@homelab/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { PageTitleStrategy } from '../../../core/page-title/page-title';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { type FakeSocket, fakeSockets } from '../../../core/realtime/testing';
import { stubLocalStorage, stubScreenWidth } from '../../../layout/testing';
import { QUIET_MS } from './log-stream';
import { LogsPage } from './logs-page';

@Component({ template: '' })
class Elsewhere {}

function line(i: number): LogLine {
  return {
    at: `2026-10-11T12:00:00.${String(i).padStart(9, '0')}Z`,
    stream: 'stdout',
    text: `line ${i}`,
  };
}
const lines = (container: string, ...batch: LogLine[]) => ({
  event: 'logs:lines',
  data: { container, lines: batch },
});
const end = (container: string, reason: string) => ({
  event: 'logs:end',
  data: { container, reason },
});

describe('LogsPage', () => {
  let storage: ReturnType<typeof stubLocalStorage>;
  let restoreScreen: () => void;
  let socket: FakeSocket;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    storage = stubLocalStorage();
    restoreScreen = stubScreenWidth(1280);
    const auth = fakeAuthApi({ user: OWNER });
    const sockets = fakeSockets();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'containers', title: 'pages.containers', component: Elsewhere },
          { path: 'containers/:name/logs', title: 'pages.logs', component: LogsPage },
        ]),
        { provide: TitleStrategy, useExisting: PageTitleStrategy },
        auth.provider,
        sockets.provider,
      ],
    });
    await TestBed.inject(AuthStore).load();
    TestBed.inject(RealtimeService).connect();
    socket = sockets.latest();
    socket.open();
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    vi.useRealTimers();
    storage.restore();
    restoreScreen();
  });

  async function visit(name: string) {
    await harness.navigateByUrl(`/containers/${name}/logs`);
    await harness.fixture.whenStable();
    return harness.routeNativeElement!;
  }

  async function receive(message: unknown) {
    socket.receive(message);
    await harness.fixture.whenStable();
  }

  const notice = (el: HTMLElement) => el.querySelector('[hlmAlert]');

  it('opens the logs of the container in the URL, titled "Logs · <name>"', async () => {
    await visit('jellyfin');
    expect(socket.sent).toEqual([
      { event: 'logs:open', data: { container: 'jellyfin', tail: 500 } },
    ]);
    expect(TestBed.inject(PageTitleStrategy).pageTitle()).toBe('Logs · jellyfin');
    expect(TestBed.inject(Title).getTitle()).toBe('Logs · jellyfin · Homelab');
  });

  it('has a back link to the Containers page and no heading of its own', async () => {
    const el = await visit('jellyfin');
    const back = el.querySelector('a')!;
    expect(back.textContent!.trim()).toBe('Containers');
    expect(back.getAttribute('href')).toBe('/containers');
    expect(el.querySelector('h1')).toBeNull();
  });

  it('shows a loading state, then the lines', async () => {
    const el = await visit('jellyfin');
    expect(el.querySelector('[role="status"]')!.getAttribute('aria-label')).toBe('Loading logs');
    await receive(lines('jellyfin', line(1), line(2)));
    expect(el.querySelector('[aria-label="Loading logs"]')).toBeNull();
    expect(el.querySelectorAll('app-log-view li')).toHaveLength(2);
    expect(notice(el)).toBeNull();
  });

  it('says "No log output yet" for a container that has written nothing', async () => {
    const el = await visit('quiet');
    // Real time: the router harness doesn't run under fake timers.
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS + 50));
    await harness.fixture.whenStable();
    expect(el.textContent).toContain('No log output yet');
    expect(el.querySelector('app-log-view')).toBeNull();
    // Lines that come later replace the message.
    await receive(lines('quiet', line(1)));
    expect(el.textContent).not.toContain('No log output yet');
    expect(el.querySelectorAll('app-log-view li')).toHaveLength(1);
  });

  describe('when the stream ends', () => {
    it('keeps a stopped container’s history, says so, and can follow again', async () => {
      const el = await visit('jellyfin');
      await receive(lines('jellyfin', line(1)));
      await receive(end('jellyfin', 'stopped'));
      expect(notice(el)!.textContent).toContain('Container is stopped');
      expect(notice(el)!.getAttribute('role')).toBe('status');
      expect(el.querySelectorAll('app-log-view li')).toHaveLength(1);

      const follow = [...el.querySelectorAll('button')].find((b) =>
        b.textContent!.includes('Follow again'),
      )!;
      follow.click();
      await harness.fixture.whenStable();
      expect(socket.sent.at(-1)).toEqual({
        event: 'logs:open',
        data: { container: 'jellyfin', tail: 500 },
      });
      expect(notice(el)).toBeNull();
    });

    it.each([
      ['removed', 'Container was removed', 'status', false],
      ['not_found', 'There is no container named “jellyfin”', 'alert', false],
      ['unavailable', 'Logs are not available', 'status', false],
      ['error', "Docker isn't reachable", 'alert', true],
    ])('explains %s in plain words', async (reason, text, role, retry) => {
      const el = await visit('jellyfin');
      await receive(end('jellyfin', reason));
      expect(notice(el)!.textContent).toContain(text);
      expect(notice(el)!.getAttribute('role')).toBe(role);
      expect(notice(el)!.querySelector('button') !== null).toBe(retry);
      expect(el.querySelector('[aria-label="Loading logs"]')).toBeNull();
    });
  });

  it('explains when too many log views are open, and can try again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const el = await visit('jellyfin');
    await receive({ event: 'error', data: { code: 'too_many_streams', message: 'x' } });
    expect(notice(el)!.textContent).toContain('Too many log views open');
    expect(notice(el)!.querySelector('button')!.textContent!.trim()).toBe('Try again');
  });

  it('says "not found" for a name that can’t be a container, without asking the server', async () => {
    const el = await visit('..%2Fsecrets');
    expect(socket.sent).toEqual([]);
    expect(notice(el)!.textContent).toContain('Container not found');
  });

  it('switches to another container’s logs when the URL changes, and closes them when left', async () => {
    await visit('jellyfin');
    await visit('postgres');
    expect(socket.sent).toEqual([
      { event: 'logs:open', data: { container: 'jellyfin', tail: 500 } },
      { event: 'logs:close', data: { container: 'jellyfin' } },
      { event: 'logs:open', data: { container: 'postgres', tail: 500 } },
    ]);
    expect(TestBed.inject(PageTitleStrategy).pageTitle()).toBe('Logs · postgres');

    await TestBed.inject(Router).navigateByUrl('/containers');
    expect(socket.sent.at(-1)).toEqual({ event: 'logs:close', data: { container: 'postgres' } });
  });

  it('fills the screen height on every size, so only the log box scrolls', async () => {
    const el = await visit('jellyfin');
    const page = el.querySelector('app-logs-page') ?? el;
    expect(page.className).toContain('h-[calc(100dvh-5.5rem)]');
    expect(page.className).toContain('md:h-[calc(100dvh-6.5rem)]');
  });

  it('wraps lines on phones', async () => {
    restoreScreen();
    restoreScreen = stubScreenWidth(375);
    const el = await visit('jellyfin');
    await receive(lines('jellyfin', line(1)));
    const wrap = [...el.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Wrap lines'),
    )!;
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
  });
});
