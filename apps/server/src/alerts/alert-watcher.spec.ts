import type { ConfigService } from '@nestjs/config';
import type { BackupWarning, DiskUsage, ContainerActionParams } from '@laris/shared';
import { Subject } from 'rxjs';
import type { BackupPlanManager } from '../backups/backup-plan-manager.js';
import type { BackupJobs } from '../backups/backup-jobs.js';
import type { BackupRuns } from '../backups/backup-runs.js';
import type { BackupStatusReader } from '../backups/backup-status-reader.js';
import type { Env } from '../config/env.schema.js';
import type { ContainerActionsService } from '../container-actions/container-actions.service.js';
import type { DiskManager } from '../disks/disk-manager.js';
import type { DockerContainer, DockerContainerEvent } from '../docker/docker.model.js';
import type { DockerService } from '../docker/docker.service.js';
import type { SystemReader } from '../host/system-reader.js';
import type { ChangesUnderway } from '../jobs/changes-underway.js';
import type { AlertRecords } from './alert-records.js';
import { AlertWatcher } from './alert-watcher.js';
import { CONTAINER_TICK_MS, DOWN_AFTER_MS, SLOW_POLL_MS } from './alerts.constants.js';
import type { AlertCondition } from './alerts.model.js';

/** Docker's events as an abortable stream the test pushes into. */
class EventFeed {
  private queue: DockerContainerEvent[] = [];
  private wake: (() => void) | null = null;
  private ending = false;
  opened = 0;

  /** Docker ends the stream (restarted). */
  end(): void {
    this.ending = true;
    this.wake?.();
  }

  push(name: string, action: string, project: string | null = name): void {
    this.queue.push({ containerId: name, action, name, composeProject: project, protected: false });
    this.wake?.();
  }

  async *events(signal: AbortSignal): AsyncGenerator<DockerContainerEvent> {
    this.opened++;
    this.ending = false;
    while (!signal.aborted && !this.ending) {
      const next = this.queue.shift();
      if (next) yield next;
      else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    }
  }
}

const container = (name: string, state = 'running'): DockerContainer => ({
  id: name,
  name,
  image: 'img',
  state: state as DockerContainer['state'],
  health: 'none',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: name,
  composeWorkingDir: `/home/anna/apps/${name}`,
  template: null,
});

describe('AlertWatcher', () => {
  let feed: EventFeed;
  let list: DockerContainer[];
  let onPurpose: boolean;
  let requests: Subject<ContainerActionParams>;
  let disks: DiskUsage[];
  let disconnected: { mountPoint: string }[];
  let warnings: BackupWarning[];
  let backupChanges: Subject<void>;
  let open: Map<string, AlertCondition[]>;
  let watcher: AlertWatcher;

  /** The conditions last reported for a kind, as `kind:subject:severity`. */
  const openNow = () =>
    [...open.values()]
      .flat()
      .map((c) => `${c.kind}:${c.subject}:${c.severity}`)
      .sort();

  beforeEach(async () => {
    vi.useFakeTimers();
    feed = new EventFeed();
    list = [container('immich')];
    onPurpose = false;
    requests = new Subject();
    disks = [];
    disconnected = [];
    warnings = [];
    backupChanges = new Subject();
    open = new Map();
    const records = {
      open: async () => [],
      reconcile: async (kinds: readonly string[], conditions: AlertCondition[]) => {
        for (const kind of kinds)
          open.set(
            kind,
            conditions.filter((c) => c.kind === kind),
          );
      },
      prune: async () => undefined,
    } as unknown as AlertRecords;
    const docker = {
      containerEvents: (signal: AbortSignal) => feed.events(signal),
      listContainers: async () => list,
    } as unknown as DockerService;
    watcher = new AlertWatcher(
      { get: () => 'on' } as unknown as ConfigService<Env, true>,
      records,
      docker,
      { requests$: requests.asObservable() } as unknown as ContainerActionsService,
      { app: () => onPurpose } as unknown as ChangesUnderway,
      { disks: async () => disks } as unknown as SystemReader,
      {
        changes$: new Subject<void>(),
        status: async () => ({ disks: [], disconnected }),
      } as unknown as DiskManager,
      { status: async () => ({ warnings }) } as unknown as BackupStatusReader,
      { changes$: backupChanges.asObservable() } as unknown as BackupJobs,
      { changes$: new Subject<void>() } as unknown as BackupRuns,
      { changes$: new Subject<void>() } as unknown as BackupPlanManager,
    );
    await watcher.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => {
    watcher.onModuleDestroy();
    vi.useRealTimers();
  });

  it('opens "service down" when an app’s container dies by itself', async () => {
    feed.push('immich', 'die');
    list = [container('immich', 'exited')];
    await vi.advanceTimersByTimeAsync(DOWN_AFTER_MS + CONTAINER_TICK_MS);
    expect(openNow()).toEqual(['serviceDown:immich:critical']);
    feed.push('immich', 'start');
    list = [container('immich')];
    await vi.advanceTimersByTimeAsync(CONTAINER_TICK_MS);
    expect(openNow()).toEqual([]);
  });

  it('doesn’t count a container stopped from the app', async () => {
    requests.next({ action: 'stop', name: 'immich' });
    feed.push('immich', 'die');
    list = [container('immich', 'exited')];
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(openNow()).toEqual([]);
  });

  it('opens "service down" for a container the list shows stopped, its death missed', async () => {
    list = [container('immich', 'exited')];
    await vi.advanceTimersByTimeAsync(30_000 + DOWN_AFTER_MS + CONTAINER_TICK_MS);
    expect(openNow()).toEqual(['serviceDown:immich:critical']);
  });

  it('doesn’t count an app stopping while it’s changed on purpose (its task, a backup, a restore)', async () => {
    onPurpose = true;
    feed.push('immich', 'die');
    await vi.advanceTimersByTimeAsync(1_000);
    onPurpose = false;
    list = [container('immich', 'exited')];
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(openNow()).toEqual([]);
  });

  it('ignores containers outside Compose', async () => {
    feed.push('random', 'die', null);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(openNow()).toEqual([]);
  });

  it('opens a restart loop for 3 deaths in 10 minutes', async () => {
    for (let i = 0; i < 3; i++) {
      feed.push('immich', 'die');
      feed.push('immich', 'start');
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(openNow()).toEqual(['restartLoop:immich:critical']);
  });

  it('reads unhealthy and out of memory from the events', async () => {
    feed.push('immich', 'health_status: unhealthy');
    feed.push('immich', 'oom');
    list = [{ ...container('immich'), health: 'unhealthy' }];
    await vi.advanceTimersByTimeAsync(2 * 60_000 + CONTAINER_TICK_MS);
    expect(openNow()).toEqual(['outOfMemory:immich:warning', 'unhealthy:immich:warning']);
  });

  it('opens the events stream again when it ends', async () => {
    expect(feed.opened).toBe(1);
    feed.end();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(feed.opened).toBe(2);
    feed.push('immich', 'oom');
    await vi.advanceTimersByTimeAsync(CONTAINER_TICK_MS);
    expect(openNow()).toEqual(['outOfMemory:immich:warning']);
  });

  it('turns backup warnings into alerts, critical for the serious ones', async () => {
    warnings = ['lastRunFailed', 'lowSpace'];
    backupChanges.next();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(openNow()).toEqual(['backup:lastRunFailed:critical', 'backup:lowSpace:warning']);
    warnings = [];
    backupChanges.next();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(openNow()).toEqual([]);
  });

  it('watches disk usage and disks gone missing every minute', async () => {
    disks = [{ device: '/dev/sda1', mount: '/', fsType: 'ext4', sizeBytes: 100, usedBytes: 95 }];
    disconnected = [{ mountPoint: '/mnt/usb' }];
    await vi.advanceTimersByTimeAsync(6 * SLOW_POLL_MS);
    expect(openNow()).toEqual(['diskFull:/:warning', 'diskMissing:/mnt/usb:warning']);
  });
});
