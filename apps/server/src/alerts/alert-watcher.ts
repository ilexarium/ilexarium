import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { catalogIdOfProject } from '@laris/shared';
import {
  auditTime,
  concatMap,
  defer,
  exhaustMap,
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
import { safely } from '../common/safely.js';
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
import { ContainerWatch } from './container-watch.js';
import { DiskWatch } from './disk-watch.js';
import {
  BACKUP_CRITICAL,
  BACKUP_SETTLE_MS,
  CONTAINER_ALERT_KINDS,
  CONTAINER_POLL_MS,
  CONTAINER_TICK_MS,
  HANDLED_ACTIONS,
  PRUNE_MS,
  SLOW_POLL_MS,
} from './alerts.constants.js';

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
    private readonly alertRecords: AlertRecords,
    private readonly dockerService: DockerService,
    private readonly containerActionsService: ContainerActionsService,
    private readonly operationSlot: OperationSlot,
    private readonly prisma: PrismaService,
    private readonly systemReader: SystemReader,
    private readonly diskManager: DiskManager,
    private readonly backupStatusReader: BackupStatusReader,
    private readonly backupResults: BackupResults,
    private readonly backupRuns: BackupRuns,
    private readonly backupPlanManager: BackupPlanManager,
  ) {
    this.enabled = config.get('ALERTS_WATCH', { infer: true }) === 'on';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const open = await this.alertRecords.open();
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
      this.dockerEvents().pipe(concatMap((event) => this.step(() => this.onEvent(event), 'event'))),
      interval(CONTAINER_POLL_MS).pipe(
        startWith(0),
        exhaustMap(() => this.step(() => this.listContainers(), 'list')),
      ),
      this.containerActionsService.requests$.pipe(
        concatMap(async (request) => {
          if (request.action !== 'start') this.containers.expect(request.name, Date.now());
        }),
      ),
      interval(CONTAINER_TICK_MS),
    ).pipe(
      exhaustMap(() =>
        this.step(
          () =>
            this.alertRecords.reconcile(
              CONTAINER_ALERT_KINDS,
              this.containers.conditions(Date.now()),
            ),
          'containers',
        ),
      ),
    );

    const diskUsage$ = interval(SLOW_POLL_MS).pipe(
      startWith(0),
      exhaustMap(() => this.step(() => this.checkDiskUsage(), 'disk usage')),
    );

    const disksMissing$ = merge(interval(SLOW_POLL_MS), this.diskManager.changes$).pipe(
      startWith(0),
      exhaustMap(() => this.step(() => this.checkDisksMissing(), 'disks')),
    );

    const backups$ = merge(
      this.backupResults.changes$,
      this.backupRuns.changes$,
      this.backupPlanManager.changes$,
      interval(SLOW_POLL_MS),
    ).pipe(
      auditTime(BACKUP_SETTLE_MS),
      startWith(0),
      exhaustMap(() => this.step(() => this.checkBackups(), 'backups')),
    );

    const prune$ = interval(PRUNE_MS).pipe(
      startWith(0),
      exhaustMap(() => this.step(() => this.alertRecords.prune(new Date()), 'prune')),
    );

    for (const stream of [containerRules$, diskUsage$, disksMissing$, backups$, prune$]) {
      this.subscriptions.push(stream.subscribe());
    }
  }

  /** Docker's events, reopened when the stream ends or fails (Docker restarted, not reachable). */
  private dockerEvents(): Observable<DockerContainerEvent> {
    return defer(() => fromAbortable((signal) => this.dockerService.containerEvents(signal))).pipe(
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
    const onPurpose = this.operationSlot.current() !== null;
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
    const catalogId = catalogIdOfProject(container.composeProject);
    if (!catalogId) return undefined;
    const service = await this.prisma.service.findUnique({
      where: { catalogId },
      select: { status: true },
    });
    return service?.status === 'installed' ? catalogId : undefined;
  }

  private async listContainers(): Promise<void> {
    const takenAt = Date.now();
    const onPurpose = this.operationSlot.current() !== null;
    const [list, services] = await Promise.all([
      this.dockerService.listContainers(),
      this.prisma.service.findMany({ where: { status: 'installed' }, select: { catalogId: true } }),
    ]);
    const installed = new Set(services.map((s) => s.catalogId));
    const watched: WatchedContainer[] = [];
    for (const container of list) {
      const catalogId = catalogIdOfProject(container.composeProject);
      if (!container.protected && !(catalogId && installed.has(catalogId))) continue;
      watched.push({
        name: container.name,
        catalogId: container.protected ? null : catalogId,
        running: container.state === 'running',
        health: container.health,
      });
    }
    // Stopped while an operation ran (when the list was asked for): not counted.
    this.containers.seen(watched, takenAt, onPurpose || this.operationSlot.current() !== null);
  }

  private async checkDiskUsage(): Promise<void> {
    const conditions = this.disks.update(await this.systemReader.disks(), Date.now());
    await this.alertRecords.reconcile(['diskFull'], conditions);
  }

  private async checkDisksMissing(): Promise<void> {
    const { disconnected } = await this.diskManager.status();
    await this.alertRecords.reconcile(
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
    const status = await this.backupStatusReader.status();
    const conditions: AlertCondition[] = status.warnings.map((warning) => ({
      kind: 'backup',
      subject: warning,
      severity: BACKUP_CRITICAL.has(warning) ? 'critical' : 'warning',
      details: {},
    }));
    await this.alertRecords.reconcile(['backup'], conditions);
  }

  /** One step of a stream: its error is logged, never reaches the subscription. */
  private step<T>(work: () => Promise<T>, what: string): Observable<T> {
    return safely(work, (error) =>
      this.logger.warn(`Watching ${what} failed: ${(error as Error).message}`),
    );
  }
}
