import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LOG_LIMITS, type LogLine } from '@ilex/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { LogsPageStore } from './logs-page-store';
import { QUIET_MS } from './logs-page-store.constants';
import { fakeEventSources } from './testing';

function line(i: number, stream: LogLine['stream'] = 'stdout'): LogLine {
  return { at: `2026-10-11T12:00:00.${String(i).padStart(9, '0')}Z`, stream, text: `line ${i}` };
}

/** A page that provides its own store, like the logs page. */
@Component({ selector: 'ilex-host', template: '', providers: [LogsPageStore] })
class Host {
  readonly logsPageStore = inject(LogsPageStore);
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function setup() {
  const auth = fakeAuthApi({ user: OWNER });
  const sources = fakeEventSources();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'login', children: [] }]),
      auth.provider,
      sources.provider,
      LogsPageStore,
    ],
  });
  await TestBed.inject(AuthStore).load();
  const logs = TestBed.inject(LogsPageStore);
  TestBed.tick();
  /** The server sends lines; they show at the next frame. */
  const send = (...lines: LogLine[]) => {
    sources.latest().emit('lines', { lines }, lines.at(-1)!.at);
    vi.advanceTimersToNextFrame();
  };
  return { logs, sources: sources.sources, source: sources.latest, send };
}

describe('LogsPageStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setVisibility('visible');
  });

  it('opens the container’s event stream for the last lines, and shows them once they come', async () => {
    const { logs, source, send } = await setup();
    logs.open('web', 100);
    expect(source().url).toBe('/api/containers/web/logs?tail=100');
    expect(logs.state()).toEqual({ status: 'loading' });

    send(line(1), line(2, 'stderr'));
    expect(logs.state()).toEqual({ status: 'live' });
    expect(logs.entries()).toEqual([
      { id: 0, ...line(1) },
      { id: 1, ...line(2, 'stderr') },
    ]);
  });

  it('asks for 500 lines by default', async () => {
    const { logs, source } = await setup();
    logs.open('a.b_c');
    expect(source().url).toBe(`/api/containers/a.b_c/logs?tail=${LOG_LIMITS.defaultTail}`);
  });

  it('counts as live with no output when nothing comes for a moment', async () => {
    const { logs } = await setup();
    logs.open('web');
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(logs.state()).toEqual({ status: 'loading' });
    vi.advanceTimersByTime(1);
    expect(logs.state()).toEqual({ status: 'live' });
    expect(logs.entries()).toEqual([]);
  });

  it('shows a flood in one update per frame', async () => {
    const { logs, source } = await setup();
    logs.open('web');
    source().emit('lines', { lines: [line(1)] }, line(1).at);
    source().emit('lines', { lines: [line(2), line(3)] }, line(3).at);
    expect(logs.entries()).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(logs.entries().map((e) => e.text)).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it('keeps only the last 10,000 of a flood that arrives before the next frame', async () => {
    const { logs, source } = await setup();
    logs.open('web');
    for (let i = 0; i < 3; i++) {
      const batch = Array.from({ length: LOG_LIMITS.maxLinesInView / 2 }, (_, j) =>
        line(i * 10_000 + j),
      );
      source().emit('lines', { lines: batch }, batch.at(-1)!.at);
    }
    vi.advanceTimersToNextFrame();
    expect(logs.entries()).toHaveLength(LOG_LIMITS.maxLinesInView);
    expect(logs.entries()[0].text).toBe('line 10000');
  });

  it('keeps the last 10,000 lines', async () => {
    const { logs, send } = await setup();
    logs.open('web');
    const many = Array.from({ length: LOG_LIMITS.maxLinesInView + 5 }, (_, i) => line(i));
    send(...many);
    expect(logs.entries()).toHaveLength(LOG_LIMITS.maxLinesInView);
    expect(logs.entries()[0].text).toBe('line 5');
  });

  it('leaves a dropped connection to the browser, which reconnects from the last event by itself', async () => {
    const { logs, sources, source, send } = await setup();
    logs.open('web');
    send(line(1));
    source().fail({ reconnecting: true });
    expect(sources).toHaveLength(1);
    expect(logs.state()).toEqual({ status: 'live' });
  });

  it('closes while the tab is hidden, and reopens after the last line when shown', async () => {
    const { logs, sources, source, send } = await setup();
    logs.open('web');
    send(line(1), line(2));
    setVisibility('hidden');
    expect(source().closed).toBe(true);
    expect(logs.state()).toEqual({ status: 'live' });

    setVisibility('visible');
    expect(sources).toHaveLength(2);
    expect(source().query).toEqual({ tail: String(LOG_LIMITS.defaultTail), since: line(2).at });
    send(line(3));
    expect(logs.entries().map((e) => e.text)).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it('reopens without since when no line had come', async () => {
    const { logs, source } = await setup();
    logs.open('web');
    setVisibility('hidden');
    setVisibility('visible');
    expect(source().query).toEqual({ tail: String(LOG_LIMITS.defaultTail) });
  });

  it('doesn’t open while the tab is hidden, only once shown — nor say "no output" meanwhile', async () => {
    const { logs, sources } = await setup();
    setVisibility('hidden');
    logs.open('web');
    expect(sources).toHaveLength(0);
    vi.advanceTimersByTime(QUIET_MS);
    expect(logs.state()).toEqual({ status: 'loading' });
    setVisibility('visible');
    expect(sources).toHaveLength(1);
  });

  it('ends with the server’s reason, keeps the lines (also those not yet shown), and closes', async () => {
    const { logs, sources, source, send } = await setup();
    logs.open('web');
    send(line(1));
    source().emit('lines', { lines: [line(2)] }, line(2).at);
    source().emit('end', { reason: 'stopped' });
    expect(logs.state()).toEqual({ status: 'ended', reason: 'stopped' });
    expect(logs.entries().map((e) => e.text)).toEqual(['line 1', 'line 2']);
    expect(source().closed).toBe(true);

    setVisibility('hidden');
    setVisibility('visible');
    expect(sources).toHaveLength(1); // not reopened
  });

  it('ends at once for a container that doesn’t exist', async () => {
    const { logs, source } = await setup();
    logs.open('nope');
    source().emit('end', { reason: 'not_found' });
    expect(logs.state()).toEqual({ status: 'ended', reason: 'not_found' });
  });

  it('ends with too_many when too many log views are open', async () => {
    const { logs, source } = await setup();
    logs.open('web');
    source().emit('end', { reason: 'too_many' });
    expect(logs.state()).toEqual({ status: 'ended', reason: 'too_many' });
    expect(source().closed).toBe(true);
    vi.advanceTimersByTime(QUIET_MS);
    expect(logs.state()).toEqual({ status: 'ended', reason: 'too_many' });
  });

  it('ends with error when the browser gives up (an error answer)', async () => {
    const { logs, source, send } = await setup();
    logs.open('web');
    send(line(1));
    source().fail({ reconnecting: false });
    expect(logs.state()).toEqual({ status: 'ended', reason: 'error' });
    expect(logs.entries()).toHaveLength(1);
  });

  it('closes and forgets its lines on close(); idempotent', async () => {
    const { logs, source, send } = await setup();
    logs.open('web');
    send(line(1));
    logs.close();
    logs.close();
    expect(source().closed).toBe(true);
    expect(logs.entries()).toEqual([]);
    expect(logs.state()).toEqual({ status: 'idle' });
  });

  it('closes the previous container when opening another, ignoring its late events', async () => {
    const { logs, sources, send } = await setup();
    logs.open('web');
    const web = sources[0];
    logs.open('db');
    expect(web.closed).toBe(true);
    web.emit('lines', { lines: [line(9)] }, line(9).at);
    send(line(1));
    expect(logs.entries().map((e) => e.text)).toEqual(['line 1']);
    expect(sources[1].url).toBe(`/api/containers/db/logs?tail=${LOG_LIMITS.defaultTail}`);
  });

  it('forgets everything on sign-out', async () => {
    const { logs, source, send } = await setup();
    logs.open('web');
    send(line(1));
    TestBed.inject(AuthStore).logout();
    TestBed.tick();
    expect(source().closed).toBe(true);
    expect(logs.entries()).toEqual([]);
  });

  it('closes when its page goes away', async () => {
    const { sources } = await setup();
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.logsPageStore.open('web');
    fixture.destroy();
    expect(sources.at(-1)!.closed).toBe(true);
  });
});
