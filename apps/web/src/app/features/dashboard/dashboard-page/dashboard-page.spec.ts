import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  ActivityItem,
  BackupsStatus,
  Container,
  InstalledService,
  SystemSnapshot,
  SystemUpdate,
} from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of } from 'rxjs';
import { ActivityApi } from '../../../core/activity/activity-api';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { alertsStatus, testAlert } from '../../../core/alerts/testing';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { ContainersApi } from '../../../core/containers/containers-api';
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
    network: [{ name: 'eth0', rxBytesPerSec: 1_200_000, txBytesPerSec: 300_000 }],
    temperature: null,
  },
  disks: [
    { device: '/dev/sda1', mount: '/', fsType: 'ext4', sizeBytes: 100 * GB, usedBytes: 46 * GB },
    { device: '/dev/sda2', mount: '/boot', fsType: 'vfat', sizeBytes: GB, usedBytes: GB / 4 },
  ],
};
const snapshot: SystemSnapshot = {
  ...update,
  host: {
    hostname: 'laris',
    os: 'Debian GNU/Linux 13',
    kernel: '6.12.0',
    arch: 'arm64',
    cpuModel: null,
    cpuCores: 4,
  },
  history: [],
};

const immich: InstalledService = {
  id: '0193a000-0000-7000-8000-0000000000aa',
  catalogId: 'immich',
  name: 'Immich',
  status: 'installed',
  settings: {},
  webPort: 2283,
  job: null,
  updatedAt: '2026-10-26T10:00:00.000Z',
};
const container = (name: string, change: Partial<Container> = {}): Container => ({
  id: name,
  name,
  image: 'immich',
  state: 'running',
  health: 'none',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: 'hl-immich',
  stats: null,
  ...change,
});

const backups: BackupsStatus = {
  configured: true,
  warnings: [],
  lastSuccessAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  nextRunAt: null,
  running: null,
  lastRun: null,
  items: [],
  restore: null,
  lastCheck: null,
};

const activity: ActivityItem[] = [
  {
    source: 'action',
    id: 'a1',
    at: new Date().toISOString(),
    action: 'container.restart',
    username: 'owner',
    subject: 'hl-navidrome-navidrome-1',
  },
  {
    source: 'backup',
    id: 'b1',
    at: new Date().toISOString(),
    trigger: 'scheduled',
    status: 'ok',
  },
];

async function render() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const containersApi = { act: vi.fn(() => of(null)) };
  const activityApi = { recent: vi.fn(() => of({ items: activity })) };
  const backupsApi = {
    runs: vi.fn(() => of({ runs: [] })),
    plan: vi.fn(() => of({ plan: null })),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: ContainersApi, useValue: containersApi },
      { provide: ActivityApi, useValue: activityApi },
      { provide: BackupsApi, useValue: backupsApi },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  // The shell follows these all session.
  TestBed.inject(BackupsStore).watch();
  TestBed.inject(AlertsStore).watch();
  const fixture = TestBed.createComponent(DashboardPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const receive = async (message: unknown) => {
    socket.receive(message);
    await fixture.whenStable();
  };
  return {
    el,
    socket,
    receive,
    containersApi,
    headline: () => el.querySelector('p[role="status"]')!.textContent!.trim(),
    unit: (light: string) => el.querySelectorAll(`laris-status-rack [data-light="${light}"]`),
    tile: (name: string) => el.querySelector(`[data-tile="${name}"]`),
    card: (title: string) => el.querySelector(`[aria-labelledby="${title}-title"]`)!,
  };
}

/** Everything a calm machine sends: the system, its apps and their containers, backups, alerts. */
async function allFine(receive: (message: unknown) => Promise<void>) {
  await receive({ event: 'system:snapshot', data: snapshot });
  await receive({ event: 'services:snapshot', data: { services: [immich] } });
  await receive({
    event: 'containers:snapshot',
    data: { dockerAvailable: true, containers: [container('hl-immich-server-1')], history: {} },
  });
  await receive({ event: 'backups:snapshot', data: backups });
  await receive({ event: 'alerts:snapshot', data: alertsStatus() });
}

describe('DashboardPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('follows the live data, and waits before saying anything about the server', async () => {
    const { el, socket, headline } = await render();
    for (const topic of ['system', 'containers', 'services']) {
      expect(socket.sent).toContainEqual({ event: 'subscribe', data: { topic } });
    }
    expect(headline()).toBe('Checking your server…');
    expect(el.querySelector('[role="status"][aria-label]')!.getAttribute('aria-label')).toBe(
      'Loading server data',
    );
  });

  it('says all is well, with the rack, the server and the tiles', async () => {
    const { el, receive, headline, unit, tile } = await render();
    await allFine(receive);

    expect(headline()).toBe('Everything is running fine');
    expect(unit('ok')).toHaveLength(3);
    const rack = el.querySelector('laris-status-rack')!.textContent!;
    expect(rack).toContain('1 app running');
    expect(rack).toContain('Last backup 3 hours ago');
    expect(rack).toContain('System disk: 54 GB free');
    expect(rack).toContain('laris');
    expect(rack).toContain('Debian GNU/Linux 13 · arm64 · 4 cores · 8.0 GB memory');
    expect(rack).toContain('Up 3 days, 4 hours');

    expect(tile('cpu')!.textContent).toContain('12%');
    expect(tile('cpu')!.textContent).toContain('Quiet');
    expect(tile('cpu')!.textContent).toContain('Load 0.52 · 0.41 · 0.33');
    expect(tile('memory')!.textContent).toContain('2.0 GB');
    expect(tile('memory')!.textContent).toContain('25%');
    expect(tile('network')!.textContent).toContain('1.2 MB/s');
  });

  it('leaves out the temperature without a sensor (Network takes its place), shows it with one', async () => {
    const { receive, tile } = await render();
    await receive({ event: 'system:snapshot', data: snapshot });
    expect(tile('temperature')).toBeNull();
    expect(tile('network')!.className).toContain('col-span-2');

    await receive({
      event: 'system:update',
      data: {
        ...update,
        sample: { ...update.sample, at: 2, temperature: { celsius: 48.2, criticalCelsius: 100 } },
      },
    });
    expect(tile('temperature')!.textContent).toContain('48°C');
    expect(tile('temperature')!.textContent).toContain('Normal');
    expect(tile('network')!.className).not.toContain('col-span-2');
  });

  it('shows only the disks that matter, without /boot', async () => {
    const { receive, card } = await render();
    await receive({ event: 'system:snapshot', data: snapshot });
    const storage = card('storage');
    expect(storage.querySelectorAll('li')).toHaveLength(1);
    expect(storage.textContent).toContain('System disk');
    expect(storage.textContent).not.toContain('/boot');
  });

  it('turns to what needs attention, with the way to the alerts', async () => {
    const { el, receive, headline, unit } = await render();
    await allFine(receive);
    await receive({ event: 'alerts:update', data: alertsStatus({ open: [testAlert()] }) });

    expect(headline()).toBe('One thing needs your attention');
    expect(unit('fail')).toHaveLength(1);
    expect(unit('fail')[0].textContent).toContain('Immich has stopped');
    expect(unit('fail')[0].textContent).toContain('Needs attention');
    expect(el.querySelector('a[href="/alerts"]')!.textContent).toContain('1 open alert');
  });

  it('starts a stopped app with one click, all of its stopped containers, with one toast', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue(0);
    const { receive, card, containersApi } = await render();
    await allFine(receive);
    await receive({
      event: 'containers:update',
      data: {
        dockerAvailable: true,
        containers: [
          container('hl-immich-server-1', { state: 'exited' }),
          container('hl-immich-ml-1', { state: 'exited' }),
        ],
      },
    });
    const apps = card('apps');
    expect(apps.textContent).toContain('Stopped');
    const start = apps.querySelector<HTMLButtonElement>('button[aria-label="Start Immich"]')!;
    start.click();
    await TestBed.inject(ContainersApi).act('x', 'start'); // let the store's awaits run
    expect(containersApi.act).toHaveBeenCalledWith('hl-immich-server-1', 'start');
    expect(containersApi.act).toHaveBeenCalledWith('hl-immich-ml-1', 'start');
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('Immich started'));
  });

  it('opens a running app on its own port', async () => {
    const { receive, card } = await render();
    await allFine(receive);
    const open = card('apps').querySelector<HTMLAnchorElement>(
      'a[aria-label="Open Immich in a new tab"]',
    )!;
    expect(open.href).toBe(`http://${location.hostname}:2283/`);
    expect(open.target).toBe('_blank');
  });

  it('asks for backups to be set up when they aren’t', async () => {
    const { receive, card, unit } = await render();
    await allFine(receive);
    await receive({ event: 'backups:update', data: { ...backups, configured: false } });
    expect(card('backups').textContent).toContain('Set up backups');
    expect(unit('warn')[0].textContent).toContain('Not set up yet');
  });

  it('shows the recent activity in plain words', async () => {
    const { receive, card } = await render();
    await allFine(receive);
    const text = card('activity').textContent!;
    expect(text).toContain('hl-navidrome-navidrome-1 restarted');
    expect(text).toContain('owner · less than a minute ago');
    expect(text).toContain('Backup finished');
    expect(text).toContain('Scheduled ·');
  });
});
