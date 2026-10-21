import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  Container,
  ContainersSnapshot,
  ContainerStats,
  SystemSnapshot,
  SystemUpdate,
} from '@laris/shared';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { RealtimeService } from '../realtime/realtime-service';
import { fakeSockets } from '../realtime/testing';
import {
  applyContainersUpdate,
  applySystemUpdate,
  HISTORY_WINDOW_MS,
  MonitoringStore,
} from './monitoring-store';

const MINUTE = 60_000;

const systemUpdate = (at: number, cpu = 10): SystemUpdate => ({
  uptimeSeconds: at / 1000,
  sample: {
    at,
    cpu: { usagePercent: cpu, loadAverage: [0, 0, 0] },
    memory: {
      totalBytes: 100,
      usedBytes: 40,
      availableBytes: 60,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    },
    network: [{ name: 'eth0', rxBytesPerSec: 3, txBytesPerSec: 1 }],
  },
  disks: [],
});

const systemSnapshot = (at: number): SystemSnapshot => ({
  ...systemUpdate(at),
  host: {
    hostname: 'laris',
    os: 'Debian',
    kernel: '6',
    arch: 'arm64',
    cpuModel: null,
    cpuCores: 4,
  },
  history: [{ at, cpuPercent: 10, memoryUsedBytes: 40, rxBytesPerSec: 3, txBytesPerSec: 1 }],
});

const stats = (at: number, cpuPercent = 5): ContainerStats => ({
  at,
  cpuPercent,
  memoryUsedBytes: 100,
  memoryLimitBytes: 1000,
  netRxBytes: 0,
  netTxBytes: 0,
  blockReadBytes: 0,
  blockWriteBytes: 0,
});

const container = (id: string, containerStats: ContainerStats | null): Container => ({
  id,
  name: id,
  image: `${id}:1`,
  state: containerStats ? 'running' : 'exited',
  health: 'none',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: null,
  stats: containerStats,
});

describe('applySystemUpdate', () => {
  it('takes the latest values and adds a chart point', () => {
    const next = applySystemUpdate(systemSnapshot(0), systemUpdate(2000, 50));
    expect(next.sample.cpu.usagePercent).toBe(50);
    expect(next.host.hostname).toBe('laris');
    expect(next.history.map((p) => [p.at, p.cpuPercent, p.rxBytesPerSec])).toEqual([
      [0, 10, 3],
      [2000, 50, 3],
    ]);
  });

  it('drops points older than 15 minutes, and never repeats a point', () => {
    let state = systemSnapshot(0);
    state = applySystemUpdate(state, systemUpdate(HISTORY_WINDOW_MS));
    state = applySystemUpdate(state, systemUpdate(HISTORY_WINDOW_MS)); // same sample again
    expect(state.history.map((p) => p.at)).toEqual([0, HISTORY_WINDOW_MS]);
    state = applySystemUpdate(state, systemUpdate(HISTORY_WINDOW_MS + 1));
    expect(state.history.map((p) => p.at)).toEqual([HISTORY_WINDOW_MS, HISTORY_WINDOW_MS + 1]);
  });
});

describe('applyContainersUpdate', () => {
  const snapshot: ContainersSnapshot = {
    dockerAvailable: true,
    containers: [container('web', stats(0)), container('old', null)],
    history: {
      web: [{ at: 0, cpuPercent: 5, memoryUsedBytes: 100 }],
      old: [{ at: 0, cpuPercent: 1, memoryUsedBytes: 1 }],
    },
  };

  it('adds a point per new stats frame, and keeps the history of stopped containers', () => {
    const next = applyContainersUpdate(snapshot, {
      dockerAvailable: true,
      containers: [container('web', stats(2000, 30)), container('old', null)],
    });
    expect(next.dockerAvailable && next.history).toEqual({
      web: [
        { at: 0, cpuPercent: 5, memoryUsedBytes: 100 },
        { at: 2000, cpuPercent: 30, memoryUsedBytes: 100 },
      ],
      old: [{ at: 0, cpuPercent: 1, memoryUsedBytes: 1 }],
    });
  });

  it('adds nothing for a stats frame it already has', () => {
    const next = applyContainersUpdate(snapshot, {
      dockerAvailable: true,
      containers: [container('web', stats(0)), container('old', null)],
    });
    expect(next.dockerAvailable && next.history['web']).toHaveLength(1);
  });

  it('drops the history of removed containers, and of points older than 15 minutes', () => {
    const next = applyContainersUpdate(snapshot, {
      dockerAvailable: true,
      containers: [container('web', stats(HISTORY_WINDOW_MS + 1))],
    });
    expect(next.dockerAvailable && next.history).toEqual({
      web: [{ at: HISTORY_WINDOW_MS + 1, cpuPercent: 5, memoryUsedBytes: 100 }],
    });
  });

  it('clears everything when Docker becomes unreachable, and starts over when it is back', () => {
    const gone = applyContainersUpdate(snapshot, { dockerAvailable: false });
    expect(gone).toEqual({ dockerAvailable: false });
    const back = applyContainersUpdate(gone, {
      dockerAvailable: true,
      containers: [container('web', stats(5 * MINUTE))],
    });
    expect(back.dockerAvailable && back.history).toEqual({
      web: [{ at: 5 * MINUTE, cpuPercent: 5, memoryUsedBytes: 100 }],
    });
  });
});

describe('MonitoringStore', () => {
  async function setup() {
    const auth = fakeAuthApi({ user: OWNER });
    const sockets = fakeSockets();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'login', children: [] }]),
        auth.provider,
        sockets.provider,
      ],
    });
    await TestBed.inject(AuthStore).load();
    TestBed.inject(RealtimeService).connect();
    sockets.latest().open();
    const store = TestBed.inject(MonitoringStore);
    TestBed.tick();
    return { store, socket: sockets.latest() };
  }

  it('fills from the snapshots, then applies updates, while watched', async () => {
    const { store, socket } = await setup();
    const stop = store.watch(['system', 'containers']);
    expect(socket.sent).toEqual([
      { event: 'subscribe', data: { topic: 'system' } },
      { event: 'subscribe', data: { topic: 'containers' } },
    ]);
    expect(store.system()).toBeNull();

    socket.receive({ event: 'system:snapshot', data: systemSnapshot(0) });
    socket.receive({ event: 'system:update', data: systemUpdate(2000, 70) });
    expect(store.system()!.sample.cpu.usagePercent).toBe(70);
    expect(store.system()!.history).toHaveLength(2);

    socket.receive({ event: 'containers:snapshot', data: { dockerAvailable: false } });
    expect(store.containers()).toEqual({ dockerAvailable: false });

    stop();
    expect(socket.sent.slice(2)).toEqual([
      { event: 'unsubscribe', data: { topic: 'system' } },
      { event: 'unsubscribe', data: { topic: 'containers' } },
    ]);
  });

  it('subscribes to the given topics only', async () => {
    const { store, socket } = await setup();
    const stop = store.watch(['containers']);
    expect(socket.sent).toEqual([{ event: 'subscribe', data: { topic: 'containers' } }]);
    socket.receive({ event: 'containers:snapshot', data: { dockerAvailable: false } });
    expect(store.containers()).toEqual({ dockerAvailable: false });
    stop();
    expect(socket.sent.slice(1)).toEqual([{ event: 'unsubscribe', data: { topic: 'containers' } }]);
  });

  it('ignores an update that arrives before its snapshot', async () => {
    const { store, socket } = await setup();
    store.watch(['system', 'containers']);
    socket.receive({ event: 'system:update', data: systemUpdate(2000) });
    socket.receive({ event: 'containers:update', data: { dockerAvailable: true, containers: [] } });
    expect(store.system()).toBeNull();
    expect(store.containers()).toBeNull();
  });

  it('keeps the last values after the page stops watching, and is reset on sign-out', async () => {
    const { store, socket } = await setup();
    const stop = store.watch(['system', 'containers']);
    socket.receive({ event: 'system:snapshot', data: systemSnapshot(0) });
    stop();
    expect(store.system()).not.toBeNull();

    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    expect(store.system()).toBeNull();
    expect(store.containers()).toBeNull();
  });
});
