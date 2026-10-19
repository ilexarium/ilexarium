import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, Router, TitleStrategy } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { LogLine } from '@homelab/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { PageTitleStrategy } from '../../../core/page-title/page-title';
import { stubLocalStorage, stubScreenWidth } from '../../../layout/testing';
import { QUIET_MS } from './logs-page-store.constants';
import { LogsPage } from './logs-page';
import { fakeEventSources } from './testing';

@Component({ template: '' })
class Elsewhere {}

function line(i: number): LogLine {
  return {
    at: `2026-10-11T12:00:00.${String(i).padStart(9, '0')}Z`,
    stream: 'stdout',
    text: `line ${i}`,
  };
}
const lines = (...batch: LogLine[]) => ({ event: 'lines', data: { lines: batch } });
const end = (reason: string) => ({ event: 'end', data: { reason } });

describe('LogsPage', () => {
  let storage: ReturnType<typeof stubLocalStorage>;
  let restoreScreen: () => void;
  let sources: ReturnType<typeof fakeEventSources>;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    storage = stubLocalStorage();
    restoreScreen = stubScreenWidth(1280);
    const auth = fakeAuthApi({ user: OWNER });
    sources = fakeEventSources();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'containers', title: 'pages.containers', component: Elsewhere },
          { path: 'containers/:name/logs', title: 'pages.logs', component: LogsPage },
        ]),
        { provide: TitleStrategy, useExisting: PageTitleStrategy },
        auth.provider,
        sources.provider,
      ],
    });
    await TestBed.inject(AuthStore).load();
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

  /** A server event, then a frame for the lines to show. */
  async function receive({ event, data }: { event: string; data: unknown }) {
    sources.latest().emit(event, data);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await harness.fixture.whenStable();
  }

  const urls = () => sources.sources.map((source) => source.url);

  const notice = (el: HTMLElement) => el.querySelector('[hlmAlert]');

  it('opens the logs of the container in the URL, titled "Logs · <name>"', async () => {
    await visit('jellyfin');
    expect(urls()).toEqual(['/api/containers/jellyfin/logs?tail=500']);
    expect(TestBed.inject(PageTitleStrategy).pageTitle()).toBe('Logs · jellyfin');
    expect(TestBed.inject(Title).getTitle()).toBe('Logs · jellyfin · Laris');
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
    await receive(lines(line(1), line(2)));
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
    await receive(lines(line(1)));
    expect(el.textContent).not.toContain('No log output yet');
    expect(el.querySelectorAll('app-log-view li')).toHaveLength(1);
  });

  describe('when the stream ends', () => {
    it('keeps a stopped container’s history, says so, and can follow again', async () => {
      const el = await visit('jellyfin');
      await receive(lines(line(1)));
      await receive(end('stopped'));
      expect(notice(el)!.textContent).toContain('Container is stopped');
      expect(notice(el)!.getAttribute('role')).toBe('status');
      expect(el.querySelectorAll('app-log-view li')).toHaveLength(1);

      const follow = [...el.querySelectorAll('button')].find((b) =>
        b.textContent!.includes('Follow again'),
      )!;
      follow.click();
      await harness.fixture.whenStable();
      expect(urls()).toHaveLength(2);
      expect(urls().at(-1)).toBe('/api/containers/jellyfin/logs?tail=500');
      expect(notice(el)).toBeNull();
    });

    it.each([
      ['removed', 'Container was removed', 'status', false],
      ['not_found', 'There is no container named “jellyfin”', 'alert', false],
      ['unavailable', 'Logs are not available', 'status', false],
      ['error', "Docker isn't reachable", 'alert', true],
    ])('explains %s in plain words', async (reason, text, role, retry) => {
      const el = await visit('jellyfin');
      await receive(end(reason));
      expect(notice(el)!.textContent).toContain(text);
      expect(notice(el)!.getAttribute('role')).toBe(role);
      expect(notice(el)!.querySelector('button') !== null).toBe(retry);
      expect(el.querySelector('[aria-label="Loading logs"]')).toBeNull();
    });
  });

  it('explains when too many log views are open, and can try again', async () => {
    const el = await visit('jellyfin');
    await receive(end('too_many'));
    expect(notice(el)!.textContent).toContain('Too many log views open');
    expect(notice(el)!.querySelector('button')!.textContent!.trim()).toBe('Try again');
  });

  it('says "not found" for a name that can’t be a container, without asking the server', async () => {
    const el = await visit('..%2Fsecrets');
    expect(urls()).toEqual([]);
    expect(notice(el)!.textContent).toContain('Container not found');
  });

  it('switches to another container’s logs when the URL changes, and closes them when left', async () => {
    await visit('jellyfin');
    await visit('postgres');
    expect(urls()).toEqual([
      '/api/containers/jellyfin/logs?tail=500',
      '/api/containers/postgres/logs?tail=500',
    ]);
    expect(sources.sources[0].closed).toBe(true);
    expect(TestBed.inject(PageTitleStrategy).pageTitle()).toBe('Logs · postgres');

    await TestBed.inject(Router).navigateByUrl('/containers');
    expect(sources.latest().closed).toBe(true);
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
    await receive(lines(line(1)));
    const wrap = [...el.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Wrap lines'),
    )!;
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
  });
});
