import type { AppSummary, BackupRun, BackupsStatus, Container, DiskUsage } from '@ilex/shared';
import { testAlert } from '../../../core/alerts/testing';
import {
  appTiles,
  backupDays,
  needsAttention,
  otherContainers,
  type RackInput,
  rackUnits,
  type RackWords,
  shownDisks,
} from './dashboard-status';

const GB = 1e9;
const words: RackWords = {
  alertTitle: (alert) => [`alerts.kind.${alert.kind}`, { name: alert.app }],
  bytes: (bytes) => `${bytes / GB} GB`,
  ago: () => '3 hours ago',
  dateTime: () => 'tonight 03:00',
  percent: (percent) => `${Math.round(percent)}%`,
  machine: (name) => name,
};

const app = (name: string, change: Partial<AppSummary> = {}): AppSummary => ({
  name,
  folder: `/home/anna/apps/${name}`,
  owner: 'anna',
  template: null,
  state: 'running',
  containers: [`${name}-server-1`],
  webPort: 8080,
  webPath: '/',
  ...change,
});

const container = (name: string, change: Partial<Container> = {}): Container => ({
  id: name,
  name,
  image: 'img',
  state: 'running',
  health: 'none',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: null,
  composeWorkingDir: null,
  template: null,
  stats: null,
  ...change,
});

const disk = (mount: string, usedGb: number, sizeGb = 100): DiskUsage => ({
  device: `/dev/${mount}`,
  mount,
  fsType: 'ext4',
  sizeBytes: sizeGb * GB,
  usedBytes: usedGb * GB,
});

const backups = (change: Partial<BackupsStatus> = {}): BackupsStatus => ({
  configured: true,
  warnings: [],
  lastSuccessAt: '2026-10-26T07:00:00.000Z',
  nextRunAt: '2026-10-27T03:00:00.000Z',
  running: null,
  lastRun: null,
  items: [],
  restore: null,
  lastCheck: null,
  ...change,
});

function input(change: Partial<RackInput> = {}): RackInput {
  return {
    alerts: [],
    apps: [app('immich')],
    docker: true,
    backups: backups(),
    disks: shownDisks([disk('/', 46)], null),
    ...change,
  };
}

const unit = (change: Partial<RackInput>, id: 'apps' | 'backups' | 'space') =>
  rackUnits(input(change), words).find((u) => u.id === id)!;

describe('rackUnits', () => {
  it('all green: apps running, the last backup and the next, space free', () => {
    const units = rackUnits(input(), words);
    expect(units.map((u) => [u.id, u.light, u.link])).toEqual([
      ['apps', 'ok', '/apps'],
      ['backups', 'ok', '/backups'],
      ['space', 'ok', '/disks'],
    ]);
    expect(units[0].text).toEqual({ key: 'dashboard.rack.apps.running', count: 1 });
    expect(units[0].sub).toEqual({ key: 'dashboard.rack.apps.healthy' });
    expect(units[1].text).toEqual({
      key: 'dashboard.rack.backups.last',
      params: { time: '3 hours ago' },
    });
    expect(units[1].sub?.params).toEqual({ time: 'tonight 03:00' });
    expect(units[2].text).toEqual({
      key: 'dashboard.rack.space.free',
      params: { name: { key: 'dashboard.disk.system' }, size: '54 GB' },
    });
    expect(needsAttention(units)).toBe(0);
  });

  it('waits while anything is still unknown', () => {
    const units = rackUnits(input({ apps: null, backups: null, disks: null }), words);
    expect(units.map((u) => [u.light, u.text.key])).toEqual([
      ['idle', 'dashboard.rack.loading'],
      ['idle', 'dashboard.rack.loading'],
      ['idle', 'dashboard.rack.loading'],
    ]);
    expect(needsAttention(units)).toBe(0);
  });

  describe('apps', () => {
    it('an open app alert lights it red (critical) or amber, in the alert’s words', () => {
      const down = unit({ alerts: [testAlert(), testAlert({ kind: 'restartLoop' })] }, 'apps');
      expect(down.light).toBe('fail');
      expect(down.text).toEqual({ key: 'alerts.kind.serviceDown', params: { name: 'immich' } });
      expect(down.sub).toEqual({ key: 'dashboard.rack.more', count: 1 });
      expect(unit({ alerts: [testAlert({ severity: 'warning' })] }, 'apps').light).toBe('warn');
    });

    it('a partly running or unhealthy app is amber', () => {
      expect(unit({ apps: [app('immich', { state: 'partial' })] }, 'apps')).toMatchObject({
        light: 'warn',
        text: { key: 'dashboard.rack.apps.partial', params: { name: 'immich' } },
      });
      expect(unit({ apps: [app('immich', { state: 'unhealthy' })] }, 'apps').text.key).toBe(
        'dashboard.rack.apps.unhealthy',
      );
    });

    it('an app stopped by hand is no problem: still green, the count says so', () => {
      const stopped = unit(
        { apps: [app('immich'), app('navidrome', { state: 'stopped' })] },
        'apps',
      );
      expect(stopped.light).toBe('ok');
      expect(stopped.text).toEqual({ key: 'dashboard.rack.apps.running', count: 1 });
      expect(stopped.sub).toEqual({ key: 'dashboard.rack.apps.stopped', count: 1 });
    });

    it('never green while the containers are unknown: waiting, or amber when Docker is down', () => {
      expect(unit({ apps: null }, 'apps')).toMatchObject({
        light: 'idle',
        text: { key: 'dashboard.rack.loading' },
      });
      expect(unit({ apps: null, docker: false }, 'apps')).toMatchObject({
        light: 'warn',
        text: { key: 'dashboard.rack.apps.dockerDown' },
      });
    });

    it('no apps yet: grey, with the way to add one', () => {
      expect(unit({ apps: [] }, 'apps')).toMatchObject({
        light: 'idle',
        text: { key: 'dashboard.rack.apps.none' },
      });
    });
  });

  describe('backups', () => {
    it('not set up is amber', () => {
      expect(unit({ backups: backups({ configured: false }) }, 'backups')).toMatchObject({
        light: 'warn',
        text: { key: 'dashboard.rack.backups.notSetUp' },
      });
    });

    it('a warning is amber, red when its alert is critical', () => {
      const warned = backups({ warnings: ['noRecentBackup'] });
      expect(unit({ backups: warned }, 'backups')).toMatchObject({
        light: 'warn',
        text: { key: 'backups.warning.noRecentBackup.title' },
      });
      const failed = backups({ warnings: ['lastRunFailed'] });
      const alert = testAlert({ kind: 'backup', warning: 'lastRunFailed', severity: 'critical' });
      expect(unit({ backups: failed, alerts: [alert] }, 'backups').light).toBe('fail');
    });

    it('a run in progress shows how far it is', () => {
      const running = backups({
        running: {
          runId: '0193a000-0000-7000-8000-000000000009',
          trigger: 'manual',
          startedAt: '2026-10-26T10:00:00.000Z',
          items: [
            {
              itemId: '0193a000-0000-7000-8000-000000000001',
              state: 'done',
              phase: null,
              result: null,
            },
            {
              itemId: '0193a000-0000-7000-8000-000000000002',
              state: 'running',
              phase: null,
              result: null,
            },
          ],
          output: [],
        },
      });
      expect(unit({ backups: running }, 'backups')).toMatchObject({
        light: 'busy',
        sub: { key: 'dashboard.rack.backups.progress', params: { done: 1, total: 2 } },
      });
    });
  });

  describe('space', () => {
    it('a disk at 80 % or more is amber, by name', () => {
      const disks = shownDisks([disk('/', 40), disk('/mnt/photos', 85)], null);
      expect(unit({ disks }, 'space')).toMatchObject({
        light: 'warn',
        text: { key: 'dashboard.rack.space.filling', params: { name: 'photos', percent: '85%' } },
      });
    });

    it('a disk alert decides, in its own words', () => {
      const missing = testAlert({ kind: 'diskMissing', subject: '/mnt/usb', severity: 'critical' });
      expect(unit({ alerts: [missing] }, 'space').light).toBe('fail');
    });

    it('no disk worth showing is said so, not taken for still loading', () => {
      expect(unit({ disks: [] }, 'space')).toMatchObject({
        light: 'idle',
        text: { key: 'dashboard.storage.none' },
      });
    });

    it('names the next disk below the system disk', () => {
      const disks = shownDisks([disk('/', 40), disk('/mnt/photos', 30, 1000)], null);
      expect(unit({ disks }, 'space').sub).toEqual({
        key: 'dashboard.rack.space.free',
        params: { name: 'photos', size: '970 GB' },
      });
    });
  });
});

describe('shownDisks', () => {
  it('leaves out the boot partitions, puts the system disk first and marks the backup disk', () => {
    const rows = shownDisks(
      [
        disk('/mnt/zeta', 1),
        disk('/boot', 1),
        disk('/boot/efi', 1),
        disk('/', 50),
        disk('/mnt/backup', 40),
      ],
      '/mnt/backup',
    );
    expect(rows.map((d) => [d.mount, d.kind, d.percent])).toEqual([
      ['/', 'system', 50],
      ['/mnt/backup', 'backup', 40],
      ['/mnt/zeta', 'other', 1],
    ]);
  });

  it('finds the backup disk of a destination inside a mount, but not a mount with a similar name', () => {
    const kinds = (destination: string) =>
      shownDisks([disk('/', 1), disk('/mnt/usb', 1), disk('/mnt/usb2', 1)], destination).map(
        (d) => d.kind,
      );
    expect(kinds('/mnt/usb2/backups')).toEqual(['system', 'other', 'backup']);
    // On the system disk (backups refuse that): it stays the system disk.
    expect(kinds('/srv/backups')).toEqual(['system', 'other', 'other']);
  });
});

describe('appTiles and otherContainers', () => {
  const containers = [
    container('immich-server-1', { composeProject: 'immich' }),
    container('immich-ml-1', { composeProject: 'immich', state: 'exited' }),
    container('ollama-ollama-1', { composeProject: 'ollama' }),
    container('ilex-postgres-1', { protected: true }),
    container('my-own-thing'),
  ];

  it('each app with its stopped containers and whether one is busy', () => {
    const tiles = appTiles(
      [
        app('immich', { state: 'partial' }),
        app('ollama', { template: { id: 'ollama', version: '2' } }),
      ],
      containers,
      new Map([['immich-ml-1', 'start']]),
    );
    expect(tiles.map((t) => [t.app.name, t.stopped, t.pending])).toEqual([
      ['immich', ['immich-ml-1'], true],
      ['ollama', [], false],
    ]);
  });

  it('counts the containers outside Compose, leaving out the platform’s own', () => {
    expect(otherContainers(containers)).toBe(1);
  });
});

describe('backupDays', () => {
  const run = (finishedAt: string, status: BackupRun['status']): BackupRun => ({
    id: finishedAt,
    trigger: 'scheduled',
    itemId: null,
    status,
    errorCode: null,
    startedAt: finishedAt,
    finishedAt,
    items: [],
  });

  it('fourteen days, oldest first, each with its worst finished run', () => {
    const today = new Date(2026, 9, 26, 12);
    const local = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
    const days = backupDays(
      [
        run(local(26, 3), 'ok'),
        run(local(25, 3), 'ok'),
        run(local(25, 15), 'warning'),
        run(local(13, 3), 'failed'),
        run(local(12, 3), 'failed'), // fifteen days ago: not shown
      ],
      today,
    );
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ date: '2026-10-13', outcome: 'failed' });
    expect(days.at(-2)).toEqual({ date: '2026-10-25', outcome: 'warning' });
    expect(days.at(-1)).toEqual({ date: '2026-10-26', outcome: 'ok' });
    expect(days.filter((d) => d.outcome === null)).toHaveLength(11);
  });
});
