import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { ServerMessage, SystemUpdate } from '@laris/shared';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { RealtimeService } from './realtime-service';
import { FIRST_RETRY_MS, MAX_RETRY_MS } from './realtime.constants';
import { fakeSockets } from './testing';

const update = {
  event: 'system:update',
  data: {
    uptimeSeconds: 1,
    sample: {
      at: 1,
      cpu: { usagePercent: 5, loadAverage: [0, 0, 0] },
      memory: {
        totalBytes: 1,
        usedBytes: 0,
        availableBytes: 1,
        swapTotalBytes: 0,
        swapUsedBytes: 0,
      },
      network: [],
      temperature: null,
    },
    disks: [],
  } satisfies SystemUpdate,
};
const subscribe = (topic: string) => ({ event: 'subscribe', data: { topic } });
const unsubscribe = (topic: string) => ({ event: 'unsubscribe', data: { topic } });

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function setup() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: 'login', children: [] }]), auth.provider, sockets.provider],
  });
  await TestBed.inject(AuthStore).load();
  const realtime = TestBed.inject(RealtimeService);
  TestBed.tick();
  return { realtime, ...sockets, ...auth };
}

describe('RealtimeService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setVisibility('visible');
  });

  it('opens one socket to /api/ws on this host, and is live once open', async () => {
    const { realtime, sockets, latest } = await setup();
    expect(realtime.status()).toBe('offline');
    realtime.connect();
    realtime.connect();
    expect(sockets).toHaveLength(1);
    expect(latest().url).toBe(`ws://${location.host}/api/ws`);
    expect(realtime.status()).toBe('connecting');
    latest().open();
    expect(realtime.status()).toBe('live');
  });

  it('subscribes once per topic, however many listeners, and unsubscribes after the last', async () => {
    const { realtime, latest } = await setup();
    realtime.connect();
    const stopA = realtime.subscribe('system', () => undefined);
    latest().open(); // subscriptions made before the socket opened are sent on open
    const stopB = realtime.subscribe('system', () => undefined);
    expect(latest().sent).toEqual([subscribe('system')]);
    stopA();
    expect(latest().sent).toEqual([subscribe('system')]);
    stopB();
    expect(latest().sent).toEqual([subscribe('system'), unsubscribe('system')]);
  });

  it("delivers a topic's messages to its listeners only", async () => {
    const { realtime, latest } = await setup();
    realtime.connect();
    latest().open();
    const system: ServerMessage[] = [];
    const containers: ServerMessage[] = [];
    realtime.subscribe('system', (m) => system.push(m));
    realtime.subscribe('containers', (m) => containers.push(m));
    latest().receive(update);
    expect(system).toEqual([update]);
    expect(containers).toEqual([]);
  });

  it('ignores invalid messages and logs server errors, without crashing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { realtime, latest } = await setup();
    realtime.connect();
    latest().open();
    const received: ServerMessage[] = [];
    realtime.subscribe('system', (m) => received.push(m));
    latest().receive('{not json');
    latest().receive({ event: 'system:update', data: { uptimeSeconds: 'soon' } });
    latest().receive({ event: 'error', data: { code: 'rate_limited', message: 'Slow down' } });
    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('reconnects with backoff — 1 s, doubling, at most 30 s — and re-subscribes', async () => {
    const { realtime, sockets, latest } = await setup();
    realtime.connect();
    realtime.subscribe('system', () => undefined);
    latest().open();

    let expectedDelay = FIRST_RETRY_MS;
    for (let attempt = 0; attempt < 8; attempt++) {
      latest().serverClose(1006);
      expect(realtime.status()).toBe('reconnecting');
      const count = sockets.length;
      await vi.advanceTimersByTimeAsync(expectedDelay - 1);
      expect(sockets).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(count + 1);
      expectedDelay = Math.min(expectedDelay * 2, MAX_RETRY_MS);
    }
    expect(expectedDelay).toBe(MAX_RETRY_MS);

    latest().open();
    expect(realtime.status()).toBe('live');
    expect(latest().sent).toEqual([subscribe('system')]);

    // A successful connection resets the backoff.
    latest().serverClose(1006);
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    expect(realtime.status()).toBe('reconnecting');
    expect(sockets.at(-1)!.readyState).toBe(0);
  });

  describe('closed with 4401 (session ended)', () => {
    it('reconnects when still signed in (e.g. after a password change)', async () => {
      const { realtime, sockets, latest, api } = await setup();
      realtime.connect();
      latest().open();
      latest().serverClose(4401);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.me).toHaveBeenCalledTimes(2); // once at startup, once now
      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
      expect(sockets).toHaveLength(2);
    });

    it('goes to the login page when the session is gone, and stops', async () => {
      const { realtime, sockets, latest, server } = await setup();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      realtime.connect();
      latest().open();
      server.user = null;
      latest().serverClose(4401);
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      expect(navigate).toHaveBeenCalledWith(['/login'], expect.anything());
      expect(TestBed.inject(AuthStore).isAuthenticated()).toBe(false);
      expect(realtime.status()).toBe('offline');
      await vi.advanceTimersByTimeAsync(10 * MAX_RETRY_MS);
      expect(sockets).toHaveLength(1);
    });

    it('keeps trying when the server cannot be asked', async () => {
      const { realtime, sockets, latest, server } = await setup();
      realtime.connect();
      latest().open();
      server.down = true;
      latest().serverClose(4401);
      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
      expect(sockets).toHaveLength(2);
      expect(TestBed.inject(AuthStore).isAuthenticated()).toBe(true);
    });
  });

  it('unsubscribes everything while the tab is hidden, and subscribes again when visible', async () => {
    const { realtime, latest } = await setup();
    realtime.connect();
    latest().open();
    realtime.subscribe('system', () => undefined);
    realtime.subscribe('containers', () => undefined);
    latest().sent.length = 0;

    setVisibility('hidden');
    expect(latest().sent).toEqual([unsubscribe('system'), unsubscribe('containers')]);
    // A page subscribing while hidden waits for the tab to be visible.
    realtime.subscribe('system', () => undefined);
    expect(latest().sent).toHaveLength(2);

    setVisibility('visible');
    expect(latest().sent.slice(2)).toEqual([subscribe('system'), subscribe('containers')]);
  });

  it('closes the socket and stops reconnecting on sign-out', async () => {
    const { realtime, sockets, latest } = await setup();
    realtime.connect();
    latest().open();
    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    expect(latest().closedWith).toBe(1000);
    expect(realtime.status()).toBe('offline');
    await vi.advanceTimersByTimeAsync(10 * MAX_RETRY_MS);
    expect(sockets).toHaveLength(1);
  });

  it('stops retrying when disconnected', async () => {
    const { realtime, sockets, latest } = await setup();
    realtime.connect();
    latest().serverClose(1006);
    realtime.disconnect();
    await vi.advanceTimersByTimeAsync(10 * MAX_RETRY_MS);
    expect(sockets).toHaveLength(1);
    expect(realtime.status()).toBe('offline');
  });
});
