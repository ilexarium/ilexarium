import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackupWarning } from '@laris/shared';
import {
  auditTime,
  catchError,
  concatMap,
  defer,
  EMPTY,
  exhaustMap,
  from,
  interval,
  merge,
  type Observable,
  repeat,
  retry,
  startWith,
  type Subscription,
  timer,
} from 'rxjs';
import { BackupPlanManager } from '../backups/backup-plan-manager.js';
import { BackupResults } from '../backups/backup-results.js';
import { BackupRuns } from '../backups/backup-runs.js';
import { BackupStatusReader } from '../backups/backup-status-reader.js';
import { fromAbortable } from '../common/from-abortable.js';
import type { Env } from '../config/env.schema.js';
import { ContainerActionsService } from '../container-actions/container-actions.service.js';
import { DiskManager } from '../disks/disk-manager.js';
import { DockerService } from '../docker/docker.service.js';
import type { DockerContainerEvent } from '../docker/docker.model.js';
import { SystemReader } from '../host/system-reader.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AlertRecords } from './alert-records.js';
import type { AlertCondition, WatchedContainer } from './alerts.model.js';
import { CONTAINER_ALERT_KINDS, ContainerWatch } from './container-watch.js';
import { DiskWatch } from './disk-watch.js';

/** The containers' rules are looked at this often (time-based: "30 s down", "2 minutes unhealthy"). */
export const CONTAINER_TICK_MS = 10_000;
/** The containers are listed this often (the events stream says the rest at once). */
export const CONTAINER_POLL_MS = 30_000;
/** Disk usage, disks gone missing, the backups' age and disk space: this often. */
export const SLOW_POLL_MS = 60_000;
const PRUNE_MS = 3_600_000;
/** Backup changes come in bursts: one look at the end. */
const BACKUP_SETTLE_MS = 1_000;

const COMPOSE_PREFIX = 'hl-';
/** The Docker events the rules use. */
const HANDLED_ACTIONS = new Set(['die', 'start', 'oom', 'health_status']);
const BACKUP_CRITICAL = new Set<BackupWarning>([
  'serviceNotRestarted',
  'repositoryDamaged',
  'lastRunFailed',
]);

/**
 * The health alerts' watcher (docs/plans/health_alerts.md): unlike the topics, it runs from
 * bootstrap until shutdown, whether anyone is looking or not. It feeds the rules (`ContainerWatch`,
 * `DiskWatch`, the backups' warnings, disks gone missing) from what the app reads already — one
 * always-open Docker events stream and a few polls — and hands what they see to `AlertRecords`.
 * No privileges: nothing here changes the system.
 *
 * Not counted as a service stopping: a stop or restart from the app (`ContainerActionsService`),
 * anything while an install, removal, restore or backup runs (`OperationSlot`), a container of a
 * service that isn't installed (being installed or removed).
 */
@Injectable()
export class AlertWatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AlertWatcher.name);
  private readonly containers = new ContainerWatch();
  private readonly disks = new DiskWatch();
  private readonly subscriptions: Subscription[] = [];
  private readonly enabled: boolean;

  constructor(
    config: ConfigService<Env, true>,
    private readonly records: AlertRecords,
    private readonly docker: DockerService,
    private readonly actions: ContainerActionsService,
    private readonly slot: OperationSlot,
    private readonly prisma: PrismaService,
    private readonly reader: SystemReader,
    private readonly diskManager: DiskManager,
    private readonly backupStatus: BackupStatusReader,
    private readonly backupResults: BackupResults,
    private readonly backupRuns: BackupRuns,
    private readonly backupPlans: BackupPlanManager,
  ) {
    this.enabled = config.get('ALERTS_WATCH', { infer: true }) === 'on';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const open = await this.records.open();
    const now = Date.now();
    this.containers.restore(open, now);
    this.disks.restore(open);
    this.start();
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions.length = 0;
  }

  private start(): void {
    const containerRules$ = merge(
      this.dockerEvents().pipe(concatMap((event) => this.safely(this.onEvent(event), 'event'))),
      interval(CONTAINER_POLL_MS).pipe(
        startWith(0),
        exhaustMap(() => this.safely(this.listContainers(), 'list')),
      ),
      this.actions.requests$.pipe(
        concatMap(async (request) => {
          if (request.action !== 'start') this.containers.expect(request.name, Date.now());
        }),
      ),
      interval(CONTAINER_TICK_MS),
    ).pipe(
      exhaustMap(() =>
        this.safely(
          this.records.reconcile(CONTAINER_ALERT_KINDS, this.containers.conditions(Date.now())),
          'containers',
        ),
      ),
    );

    const diskUsage$ = interval(SLOW_POLL_MS).pipe(
      startWith(0),
      exhaustMap(() => this.safely(this.checkDiskUsage(), 'disk usage')),
    );

    const disksMissing$ = merge(interval(SLOW_POLL_MS), this.diskManager.changes$).pipe(
      startWith(0),
      exhaustMap(() => this.safely(this.checkDisksMissing(), 'disks')),
    );

    const backups$ = merge(
      this.backupResults.changes$,
      this.backupRuns.changes$,
      this.backupPlans.changes$,
      interval(SLOW_POLL_MS),
    ).pipe(
      auditTime(BACKUP_SETTLE_MS),
      startWith(0),
      exhaustMap(() => this.safely(this.checkBackups(), 'backups')),
    );

    const prune$ = interval(PRUNE_MS).pipe(
      startWith(0),
      exhaustMap(() => this.safely(this.records.prune(new Date()), 'prune')),
    );

    for (const stream of [containerRules$, diskUsage$, disksMissing$, backups$, prune$]) {
      this.subscriptions.push(stream.subscribe());
    }
  }

  /** Docker's events, reopened when the stream ends or fails (Docker restarted, not reachable). */
  private dockerEvents(): Observable<DockerContainerEvent> {
    return defer(() => fromAbortable((signal) => this.docker.containerEvents(signal))).pipe(
      retry({
        delay: (_error, count) => timer(Math.min(60_000, 1_000 * 2 ** count)),
        resetOnSuccess: true,
      }),
      repeat({ delay: 5_000 }),
    );
  }

  private async onEvent(event: DockerContainerEvent): Promise<void> {
    // Taken when it happened, not after the lookup below.
    const now = Date.now();
    const onPurpose = this.slot.current() !== null;
    const [action, status] = event.action.split(':').map((part) => part.trim());
    // Only these say anything to the rules: no database lookup for the rest (create, stop, …).
    if (!event.name || !HANDLED_ACTIONS.has(action)) return;
    const catalogId = await this.watchedCatalogId(event);
    if (catalogId === undefined) return;
    switch (action) {
      case 'die':
        if (onPurpose) {
          this.containers.stoppedOnPurpose(event.name, catalogId, now);
        } else this.containers.died(event.name, catalogId, now);
        break;
      case 'start':
        this.containers.started(event.name, catalogId, now);
        break;
      case 'oom':
        this.containers.outOfMemory(event.name, catalogId, now);
        break;
      case 'health_status':
        if (status === 'healthy' || status === 'unhealthy' || status === 'starting') {
          this.containers.health(event.name, catalogId, status, now);
        }
        break;
    }
  }

  /**
   * Whose container: the catalog entry of an installed service (`hl-<id>`), null for the
   * platform's own (labelled protected), undefined for one not watched.
   */
  private async watchedCatalogId(
    container: Pick<DockerContainerEvent, 'composeProject' | 'protected'>,
  ): Promise<string | null | undefined> {
    if (container.protected) return null;
    const project = container.composeProject;
    if (!project?.startsWith(COMPOSE_PREFIX)) return undefined;
    const catalogId = project.slice(COMPOSE_PREFIX.length);
    const service = await this.prisma.service.findUnique({
      where: { catalogId },
      select: { status: true },
    });
    return service?.status === 'installed' ? catalogId : undefined;
  }

  private async listContainers(): Promise<void> {
    const takenAt = Date.now();
    const onPurpose = this.slot.current() !== null;
    const [list, services] = await Promise.all([
      this.docker.listContainers(),
      this.prisma.service.findMany({ where: { status: 'installed' }, select: { catalogId: true } }),
    ]);
    const installed = new Set(services.map((s) => s.catalogId));
    const watched: WatchedContainer[] = [];
    for (const container of list) {
      const project = container.composeProject ?? '';
      const catalogId = project.startsWith(COMPOSE_PREFIX)
        ? project.slice(COMPOSE_PREFIX.length)
        : null;
      if (!container.protected && !(catalogId && installed.has(catalogId))) continue;
      watched.push({
        name: container.name,
        catalogId: container.protected ? null : catalogId,
        running: container.state === 'running',
        health: container.health,
      });
    }
    // Stopped while an operation ran (when the list was asked for): not counted.
    this.containers.seen(watched, takenAt, onPurpose || this.slot.current() !== null);
  }

  private async checkDiskUsage(): Promise<void> {
    const conditions = this.disks.update(await this.reader.disks(), Date.now());
    await this.records.reconcile(['diskFull'], conditions);
  }

  private async checkDisksMissing(): Promise<void> {
    const { disconnected } = await this.diskManager.status();
    await this.records.reconcile(
      ['diskMissing'],
      disconnected.map((disk) => ({
        kind: 'diskMissing',
        subject: disk.mountPoint,
        severity: 'warning',
        details: {},
      })),
    );
  }

  private async checkBackups(): Promise<void> {
    const status = await this.backupStatus.status();
    const conditions: AlertCondition[] = status.warnings.map((warning) => ({
      kind: 'backup',
      subject: warning,
      severity: BACKUP_CRITICAL.has(warning) ? 'critical' : 'warning',
      details: {},
    }));
    await this.records.reconcile(['backup'], conditions);
  }

  /** One step of a stream: its error is logged, never reaches the subscription. */
  private safely<T>(work: Promise<T>, what: string): Observable<T> {
    return from(work).pipe(
      catchError((error: unknown) => {
        this.logger.warn(`Watching ${what} failed: ${(error as Error).message}`);
        return EMPTY;
      }),
    );
  }
}
