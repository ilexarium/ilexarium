import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { SystemSnapshot, SystemUpdate } from '@homelab/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { DashboardPage } from './dashboard-page';

const GB = 1e9;
const update: SystemUpdate = {
  uptimeSeconds: 3 * 86_400 + 4 * 3_600,
  sample: {
    at: 1,
    cpu: { usagePercent: 12.4, loadAverage: [0.52, 0.41, 0.33] },
    memory: {
      totalBytes: 8 * GB,
      usedBytes: 2 * GB,
      availableBytes: 6 * GB,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    },
    network: [
      { name: 'eth0', rxBytesPerSec: 1_200_000, txBytesPerSec: 300_000 },
      { name: 'tailscale0', rxBytesPerSec: 0, txBytesPerSec: 1_000 },
    ],
  },
  disks: [
    { device: '/dev/sda1', mount: '/', fsType: 'ext4', sizeBytes: 100 * GB, usedBytes: 95 * GB },
  ],
};
const snapshot: SystemSnapshot = {
  ...update,
  host: {
    hostname: 'homelab',
    os: 'Debian GNU/Linux 13',
    kernel: '6.12.0',
    arch: 'arm64',
    cpuModel: null,
    cpuCores: 4,
  },
  history: [],
};

async function render() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  TestBed.configureTestingModule({
    providers: [provideRouter([]), auth.provider, sockets.provider],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const fixture = TestBed.createComponent(DashboardPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    el,
    socket,
    card: (title: string) => el.querySelector(`[aria-labelledby="${title}-title"]`)!,
  };
}

describe('DashboardPage', () => {
  it('subscribes to the live data, and shows a loading state until the first snapshot', async () => {
    const { el, socket } = await render();
    expect(socket.sent).toContainEqual({ event: 'subscribe', data: { topic: 'system' } });
    expect(el.querySelector('[role="status"]')!.getAttribute('aria-label')).toBe(
      'Loading server data',
    );
  });

  it('shows the host, CPU, memory, network and storage from the snapshot', async () => {
    const { fixture, el, socket, card } = await render();
    socket.receive({ event: 'system:snapshot', data: snapshot });
    await fixture.whenStable();

    expect(el.querySelector('app-host-summary')!.textContent).toContain('homelab');
    expect(el.querySelector('app-host-summary')!.textContent).toContain('up 3 days, 4 hours');
    expect(card('cpu').textContent).toContain('12%');
    expect(card('cpu').textContent).toContain('4 cores');
    expect(card('cpu').textContent).toContain('0.52 · 0.41 · 0.33');
    expect(card('memory').textContent).toContain('25%');
    expect(card('memory').textContent).toContain('2.0 GB in use');
    expect(card('memory').textContent).toContain('No swap');
    expect(card('network').textContent).toContain('1.2 MB/s');
    expect(card('network').textContent).toContain('tailscale0');
    expect(card('storage').textContent).toContain('Almost full');
  });

  it('shows the containers, and charts described for screen readers', async () => {
    const { fixture, el, socket, card } = await render();
    socket.receive({
      event: 'system:snapshot',
      data: {
        ...snapshot,
        history: [
          {
            at: 1,
            cpuPercent: 12.4,
            memoryUsedBytes: 2 * GB,
            rxBytesPerSec: 1_200_000,
            txBytesPerSec: 301_000,
          },
        ],
      },
    });
    socket.receive({ event: 'containers:snapshot', data: { dockerAvailable: false } });
    await fixture.whenStable();
    expect(card('containers').textContent).toContain("Docker isn't reachable");
    const charts = [...el.querySelectorAll('app-metric-chart [role="img"]')].map((c) =>
      c.getAttribute('aria-label'),
    );
    expect(charts).toEqual([
      'CPU usage, last 15 minutes: now CPU 12%',
      'Memory in use, last 15 minutes: now In use 2.0 GB',
      'Network traffic, last 15 minutes: now Receiving 1.2 MB/s, Sending 301 kB/s',
    ]);
  });

  it('follows live updates', async () => {
    const { fixture, socket, card } = await render();
    socket.receive({ event: 'system:snapshot', data: snapshot });
    socket.receive({
      event: 'system:update',
      data: {
        ...update,
        sample: { ...update.sample, at: 2, cpu: { ...update.sample.cpu, usagePercent: 87 } },
      },
    });
    await fixture.whenStable();
    expect(card('cpu').textContent).toContain('87%');
  });

  it('stops the live data when left', async () => {
    const { fixture, socket } = await render();
    fixture.destroy();
    expect(socket.sent).toContainEqual({ event: 'unsubscribe', data: { topic: 'system' } });
    expect(socket.sent).toContainEqual({ event: 'unsubscribe', data: { topic: 'containers' } });
  });
});
