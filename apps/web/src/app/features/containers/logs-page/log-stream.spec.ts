import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LOG_LIMITS, type LogLine } from '@homelab/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { FIRST_RETRY_MS, RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { LogStream, QUIET_MS } from './log-stream';

function line(i: number, stream: LogLine['stream'] = 'stdout'): LogLine {
  return { at: `2026-10-11T12:00:00.${String(i).padStart(9, '0')}Z`, stream, text: `line ${i}` };
}
const lines = (container: string, ...batch: LogLine[]) => ({
  event: 'logs:lines',
  data: { container, lines: batch },
});
const end = (container: string, reason: string) => ({
  event: 'logs:end',
  data: { container, reason },
});

/** A page that provides its own stream, like the logs page will. */
@Component({ selector: 'app-host', template: '', providers: [LogStream] })
class Host {
  readonly logs = inject(LogStream);
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function setup() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'login', children: [] }]),
      auth.provider,
      sockets.provider,
      LogStream,
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  sockets.latest().open();
  const logs = TestBed.inject(LogStream);
  TestBed.tick();
  return { logs, socket: () => sockets.latest() };
}

describe('LogStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setVisibility('visible');
  });

  it('asks for the last lines, and shows them once they come', async () => {
    const { logs, socket } = await setup();
    logs.open('web', 100);
    expect(socket().sent).toEqual([{ event: 'logs:open', data: { container: 'web', tail: 100 } }]);
    expect(logs.state()).toEqual({ status: 'loading' });

    socket().receive(lines('web', line(1), line(2, 'stderr')));
    expect(logs.state()).toEqual({ status: 'live' });
    expect(logs.entries()).toEqual([
      { kind: 'line', id: 0, ...line(1) },
      { kind: 'line', id: 1, ...line(2, 'stderr') },
    ]);
  });

  it('asks for 500 lines by default', async () => {
    const { logs, socket } = await setup();
    logs.open('web');
    expect(socket().sent).toEqual([
      { event: 'logs:open', data: { container: 'web', tail: LOG_LIMITS.defaultTail } },
    ]);
  });

  it('counts as live with no output when nothing comes for a moment', async () => {
    const { logs } = await setup();
    logs.open('web');
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(logs.state()).toEqual({ status: 'loading' });
    await vi.advanceTimersByTimeAsync(1);
    expect(logs.state()).toEqual({ status: 'live' });
    expect(logs.entries()).toEqual([]);
  });

  it('adds a marker where the server skipped lines', async () => {
    const { logs, socket } = await setup();
    logs.open('web');
    socket().receive({
      ...lines('web', line(1)),
      data: { container: 'web', lines: [line(1)], skipped: 900 },
    });
    socket().receive(lines('web', line(2)));
    expect(logs.entries().map((e) => (e.kind === 'line' ? e.text : `skipped ${e.count}`))).toEqual([
      'line 1',
      'skipped 900',
      'line 2',
    ]);
  });

  it('keeps the last 10,000 entries', async () => {
    const { logs, socket } = await setup();
    logs.open('web');
    for (let batch = 0; batch < 3; batch++) {
      const batchLines = Array.from({ length: 5000 }, (_, i) => line(batch * 5000 + i + 1));
      socket().receive(lines('web', ...batchLines));
    }
    expect(logs.entries()).toHaveLength(LOG_LIMITS.maxLinesInView);
    const first = logs.entries()[0];
    expect(first.kind === 'line' && first.text).toBe('line 5001');
  });

  it('resumes after a reconnect from the last line it has, without repeating any', async () => {
    const { logs, socket } = await setup();
    logs.open('web', 100);
    socket().receive(lines('web', line(1), line(2)));
    socket().serverClose(1006);
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    socket().open();
    expect(socket().sent).toEqual([
      {
        event: 'logs:open',
        data: { container: 'web', tail: LOG_LIMITS.maxTail, since: line(2).at },
      },
    ]);
    // Even if the server sent a line it has again, it appears once.
    socket().receive(lines('web', line(2), line(3)));
    expect(logs.entries().map((e) => e.id)).toEqual([0, 1, 2]);
    expect(logs.entries().map((e) => e.kind === 'line' && e.text)).toEqual([
      'line 1',
      'line 2',
      'line 3',
    ]);
    expect(logs.state()).toEqual({ status: 'live' });
  });

  it('asks again for the last lines after a reconnect if none had come', async () => {
    const { logs, socket } = await setup();
    logs.open('web', 100);
    socket().serverClose(1006);
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    socket().open();
    expect(socket().sent).toEqual([{ event: 'logs:open', data: { container: 'web', tail: 100 } }]);
  });

  it('closes on the server while the tab is hidden, and resumes when it is shown', async () => {
    const { logs, socket } = await setup();
    logs.open('web');
    socket().receive(lines('web', line(1)));
    socket().sent.length = 0;
    setVisibility('hidden');
    expect(socket().sent).toEqual([{ event: 'logs:close', data: { container: 'web' } }]);
    setVisibility('visible');
    expect(socket().sent[1]).toEqual({
      event: 'logs:open',
      data: { container: 'web', tail: LOG_LIMITS.maxTail, since: line(1).at },
    });
    expect(logs.entries()).toHaveLength(1);
  });

  it('ends with the server’s reason, keeps the lines, and isn’t resumed', async () => {
    const { logs, socket } = await setup();
    logs.open('web');
    socket().receive(lines('web', line(1)));
    socket().receive(end('web', 'stopped'));
    expect(logs.state()).toEqual({ status: 'ended', reason: 'stopped' });
    expect(logs.entries()).toHaveLength(1);

    socket().serverClose(1006);
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    socket().open();
    expect(socket().sent).toEqual([]);
    socket().receive(lines('web', line(2))); // late lines are ignored
    expect(logs.entries()).toHaveLength(1);
  });

  it('ends at once for a container that doesn’t exist', async () => {
    const { logs, socket } = await setup();
    logs.open('nope');
    socket().receive(end('nope', 'not_found'));
    expect(logs.state()).toEqual({ status: 'ended', reason: 'not_found' });
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(logs.state()).toEqual({ status: 'ended', reason: 'not_found' });
  });

  it('ignores other containers’ messages', async () => {
    const { logs, socket } = await setup();
    logs.open('web');
    socket().receive(lines('db', line(1)));
    socket().receive(end('db', 'stopped'));
    expect(logs.entries()).toEqual([]);
    expect(logs.state()).toEqual({ status: 'loading' });
  });

  it('is refused when too many log views are open — only while waiting for its first lines', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tooMany = { event: 'error', data: { code: 'too_many_streams', message: 'x' } };
    const { logs, socket } = await setup();
    logs.open('web');
    socket().receive(tooMany);
    expect(logs.state()).toEqual({ status: 'refused' });

    logs.open('db');
    socket().receive(lines('db', line(1)));
    socket().receive(tooMany); // another stream's refusal
    expect(logs.state()).toEqual({ status: 'live' });
  });

  it('closes on the server and forgets its lines on close(); idempotent', async () => {
    const { logs, socket } = await setup();
    logs.open('web');
    socket().receive(lines('web', line(1)));
    logs.close();
    logs.close();
    expect(socket().sent.slice(1)).toEqual([{ event: 'logs:close', data: { container: 'web' } }]);
    expect(logs.entries()).toEqual([]);
    expect(logs.state()).toEqual({ status: 'idle' });
    socket().receive(lines('web', line(2)));
    expect(logs.entries()).toEqual([]);
  });

  it('closes the previous container when opening another', async () => {
    const { logs, socket } = await setup();
    logs.open('web');
    logs.open('db');
    expect(socket().sent).toEqual([
      { event: 'logs:open', data: { container: 'web', tail: 500 } },
      { event: 'logs:close', data: { container: 'web' } },
      { event: 'logs:open', data: { container: 'db', tail: 500 } },
    ]);
  });

  it('forgets everything on sign-out', async () => {
    const { logs, socket } = await setup();
    logs.open('web');
    socket().receive(lines('web', line(1)));
    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    expect(logs.entries()).toEqual([]);
    expect(logs.state()).toEqual({ status: 'idle' });
  });

  it('closes on the server when its page goes away', async () => {
    const { socket } = await setup();
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.logs.open('web');
    fixture.destroy();
    expect(socket().sent.at(-1)).toEqual({ event: 'logs:close', data: { container: 'web' } });
  });
});
