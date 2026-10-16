import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type ApiErrorResponse,
  BACKUP_ERROR_CODES,
  BACKUP_FILESYSTEMS,
  BACKUP_LIMITS,
  type BackupArchive,
  type BackupDestination,
  type BackupErrorCode,
  type BackupFoldersResponse,
  type BackupItem,
  type BackupItemRequest,
  type BackupItemResult,
  type BackupPlan,
  type BackupPlanUpdate,
  type BackupRestore,
  type BackupRestoreRequest,
  type BackupRetention,
  type BackupRun,
  type BackupRunRequest,
  type BackupSchedule,
  type BackupSetupRequest,
  type BackupsStatus,
  type FieldError,
  isPlainAbsolutePath,
} from '@homelab/shared';
import { AuthService } from '../auth/auth.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type {
  BackupOutcome,
  ExecutorActor,
  WrapperBackupItem,
  WrapperBackupPlan,
} from '../executor/executor.model.js';
import { ExecutorService } from '../executor/executor.service.js';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { SystemReader } from '../host/system-reader.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  archiveTime,
  inside,
  isAllowedFolder,
  isDestinationPath,
  mountInfoFile,
  repositoryPath,
} from './backup-paths.js';
import { BackupProgressFollower } from './backup-progress.js';
import { BackupRestores } from './backup-restores.js';
import { BackupResults } from './backup-results.js';
import { backupWarnings, nextRunAt } from './backup-status.js';

/** Lines of the running restore's output in the topic (all of them from its own route). */
const TOPIC_LINES = 50;
const RUNS_SHOWN = 50;
const RESTORES_SHOWN = 20;
/** Results looked at per item for "last backed up" (a day's runs every 6 hours, and then some). */
const RESULTS_PER_ITEM = 30;
/**
 * "Back up now" keeps the one-operation slot until its run shows in the progress file (or has a
 * result): then the follower holds it, like for a scheduled run. Seconds, normally.
 */
export const HANDOVER_MS = 30_000;
const HANDOVER_POLL_MS = 200;

const itemInclude = {
  service: { select: { catalogId: true, status: true, settings: true } },
  results: {
    orderBy: { run: { startedAt: 'desc' } },
    take: RESULTS_PER_ITEM,
    include: { run: { select: { startedAt: true, finishedAt: true } } },
  },
} satisfies Prisma.BackupItemInclude;
type ItemRow = Prisma.BackupItemGetPayload<{ include: typeof itemInclude }>;
type ResultRow = ItemRow['results'][number];

/**
 * Backups (docs/plans/backups.md): the plan and what's in it, setting up the repository, "Back up
 * now", restores, the passphrase — and the status the app shows. The database is the app's
 * truth; every change of the plan goes to the backup wrapper's `configure`, which checks it all
 * and writes the copy the timer uses. Every privileged step goes through the executor (audited,
 * fail closed); the friendly checks here come first.
 */
@Injectable()
export class BackupManager {
  private readonly logger = new Logger(BackupManager.name);
  /** Plan changes one after another: each writes the whole plan. */
  private planChange: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly executor: ExecutorService,
    private readonly wrapperConfig: WrapperConfigService,
    private readonly reader: SystemReader,
    private readonly slot: OperationSlot,
    private readonly results: BackupResults,
    private readonly progress: BackupProgressFollower,
    private readonly restoreJobs: BackupRestores,
    private readonly auth: AuthService,
  ) {}

  /** Called when the plan or its items change. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Destinations and folders.

  /** Mounted disks under /mnt and /media, with their free space and the same-disk warning. */
  async destinations(): Promise<BackupDestination[]> {
    const config = this.wrapperConfig.config;
    const mounts = new Map<string, string>();
    for (const point of await this.reader.mountPoints(mountInfoFile(config))) {
      if (isDestinationPath(config, point.mount)) mounts.set(point.mount, point.fsType);
    }
    const dataDevices = new Set(
      (
        await Promise.all([...config.storageRoots, '/home'].map((p) => this.reader.device(p)))
      ).filter((d): d is number => d !== null),
    );
    const destinations = await Promise.all(
      [...mounts].map(async ([mountPoint, filesystem]): Promise<BackupDestination> => {
        const [space, device, repository] = await Promise.all([
          this.reader.space(mountPoint),
          this.reader.device(mountPoint),
          this.reader.folder(repositoryPath(mountPoint)),
        ]);
        return {
          mountPoint,
          filesystem,
          supported: (BACKUP_FILESYSTEMS as readonly string[]).includes(filesystem),
          totalBytes: space?.totalBytes ?? 0,
          freeBytes: space?.freeBytes ?? 0,
          sameDiskAsData: device !== null && dataDevices.has(device),
          hasRepository: repository !== 'missing',
        };
      }),
    );
    return destinations.sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
  }

  /** The folder picker: the starting places, or the folders inside one. */
  async folders(path?: string): Promise<BackupFoldersResponse> {
    const config = this.wrapperConfig.config;
    const entry = (p: string, name: string) => ({
      name,
      path: p,
      allowed: isAllowedFolder(config, p),
    });
    if (path === undefined) {
      const homes = (await this.reader.subfolders('/home')) ?? [];
      return {
        path: null,
        parent: null,
        readable: true,
        folders: [
          ...config.storageRoots.map((root) => entry(root, root)),
          ...homes.map((home) => entry(home.path, home.path)),
        ],
      };
    }
    if (!isAllowedFolder(config, path)) {
      throw new BadRequestException(
        error('Not a folder that can be backed up', BACKUP_ERROR_CODES.pathNotAllowed),
      );
    }
    const parent = dirname(path);
    const children = await this.reader.subfolders(path);
    return {
      path,
      parent: isAllowedFolder(config, parent) ? parent : null,
      readable: children !== null,
      folders: (children ?? []).map((child) => entry(child.path, child.name)),
    };
  }

  // The plan.

  async plan(): Promise<BackupPlan | null> {
    const plan = await this.prisma.backupPlan.findUnique({ where: { id: 1 } });
    if (!plan) return null;
    const [items, destinations] = await Promise.all([
      this.prisma.backupItem.findMany({ include: itemInclude, orderBy: { createdAt: 'asc' } }),
      this.destinations(),
    ]);
    return {
      destination: plan.destination,
      schedule: plan.schedule as BackupSchedule,
      retention: plan.retention as BackupRetention,
      destinationStatus: destinations.find((d) => d.mountPoint === plan.destination) ?? null,
      items: items.map((item) => this.itemView(item)),
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }

  /**
   * Sets backups up once: creates the repository (and its passphrase) on the chosen disk, writes
   * the plan for the timer, and returns the passphrase — shown once, to be written down.
   */
  async setup(request: BackupSetupRequest, actor: ExecutorActor): Promise<{ passphrase: string }> {
    if (await this.prisma.backupPlan.findUnique({ where: { id: 1 } })) {
      throw new ConflictException(
        error('Backups are set up already', BACKUP_ERROR_CODES.alreadyConfigured),
      );
    }
    await this.checkDestination(request.destination);
    const items = await this.checkNewItems(request.items, request.destination);
    const release = this.slot.claim('backupTask');
    try {
      const init = await this.call(() => this.executor.backupInit(request.destination, actor));
      const platformId = randomUUID();
      const rows = [{ id: platformId, kind: 'platform' as const }, ...items];
      const wrapperPlan: WrapperBackupPlan = {
        destination: request.destination,
        schedule: request.schedule,
        retention: request.retention,
        items: await this.wrapperItems(rows),
      };
      await this.call(() => this.executor.backupConfigure(wrapperPlan, actor));
      await this.prisma.$transaction([
        this.prisma.backupPlan.create({
          data: {
            id: 1,
            destination: request.destination,
            repositoryId: init.repositoryId,
            schedule: request.schedule,
            retention: request.retention,
          },
        }),
        this.prisma.backupItem.createMany({
          data: rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            serviceId: 'serviceId' in row ? row.serviceId : null,
            path: 'path' in row ? row.path : null,
            excludedFields: 'excludedFields' in row ? row.excludedFields : [],
          })),
        }),
      ]);
      const { passphrase } = await this.call(() => this.executor.backupPassphrase(actor, 'setup'));
      this.notify();
      return { passphrase };
    } finally {
      release();
    }
  }

  /** Changes the schedule, the retention or the disk (a new disk gets a new repository). */
  async updatePlan(request: BackupPlanUpdate, actor: ExecutorActor): Promise<BackupPlan> {
    await this.changePlan(async () => {
      const plan = await this.requirePlan();
      const data: Prisma.BackupPlanUpdateInput = {};
      if (request.schedule) data.schedule = request.schedule;
      if (request.retention) data.retention = request.retention;
      if (request.destination && request.destination !== plan.destination) {
        await this.checkDestination(request.destination);
        await this.checkItemsOffDisk(request.destination);
        const release = this.slot.claim('backupTask');
        try {
          const init = await this.call(() => this.executor.backupInit(request.destination!, actor));
          data.destination = request.destination;
          data.repositoryId = init.repositoryId;
        } finally {
          release();
        }
      }
      await this.applyPlanChange(actor, async (tx) => {
        await tx.backupPlan.update({ where: { id: 1 }, data });
        // A new repository: the archives on the old disk aren't reachable from here.
        if (data.destination) {
          await tx.backupItem.updateMany({ data: { archives: [], archivesAt: null } });
        }
      });
    });
    return (await this.plan())!;
  }

  // Items.

  /** Adds a service or a folder (one removed earlier comes back, with its archives). */
  async addItem(request: BackupItemRequest, actor: ExecutorActor): Promise<BackupItem> {
    let id = '';
    await this.changePlan(async () => {
      const plan = await this.requirePlan();
      const [row] = await this.checkNewItems([request], plan.destination);
      const removed = await this.prisma.backupItem.findFirst({
        where:
          row.kind === 'service'
            ? { kind: 'service', serviceId: row.serviceId, removedAt: { not: null } }
            : { kind: 'folder', path: row.path, removedAt: { not: null } },
      });
      id = removed?.id ?? row.id;
      await this.applyPlanChange(actor, async (tx) => {
        if (removed) {
          await tx.backupItem.update({
            where: { id: removed.id },
            data: {
              removedAt: null,
              excludedFields: row.kind === 'service' ? row.excludedFields : [],
            },
          });
        } else {
          await tx.backupItem.create({
            data: {
              id: row.id,
              kind: row.kind,
              serviceId: row.kind === 'service' ? row.serviceId : null,
              path: row.kind === 'folder' ? row.path : null,
              excludedFields: row.kind === 'service' ? row.excludedFields : [],
            },
          });
        }
      });
    });
    return this.item(id);
  }

  /**
   * After an install with "Include in backups": adds the service if a plan exists. Never fails
   * the install — a problem is logged and the service is simply not backed up yet.
   */
  async includeInstalledService(serviceId: string, actor: ExecutorActor): Promise<void> {
    try {
      if (!(await this.prisma.backupPlan.findUnique({ where: { id: 1 } }))) return;
      const active = await this.prisma.backupItem.findFirst({
        where: { serviceId, removedAt: null },
      });
      if (active) return;
      await this.addItem({ kind: 'service', serviceId }, actor);
    } catch (failure) {
      this.logger.warn(`Could not add service ${serviceId} to the backups: ${String(failure)}`);
    }
  }

  /** A service item's folders switched off. */
  async updateItem(
    id: string,
    excludedFields: string[],
    actor: ExecutorActor,
  ): Promise<BackupItem> {
    await this.changePlan(async () => {
      const item = await this.requireItem(id);
      if (item.kind !== 'service' || item.removedAt) {
        throw new BadRequestException(
          error('Only a service’s folders can be switched off', BACKUP_ERROR_CODES.itemFixed),
        );
      }
      this.checkExcluded(item.service?.catalogId ?? '', excludedFields);
      await this.applyPlanChange(actor, (tx) =>
        tx.backupItem.update({ where: { id }, data: { excludedFields } }),
      );
    });
    return this.item(id);
  }

  /**
   * Takes an item out of the plan; its archives stay — unless `deleteArchives` (confirmed in the
   * browser), then they're deleted and the item is gone. The platform always stays.
   */
  async removeItem(id: string, deleteArchives: boolean, actor: ExecutorActor): Promise<void> {
    await this.changePlan(async () => {
      const item = await this.requireItem(id);
      if (item.kind === 'platform') {
        throw new BadRequestException(
          error('The platform is always backed up', BACKUP_ERROR_CODES.itemFixed),
        );
      }
      if (deleteArchives) await this.checkNoSetAside(id);
      if (!item.removedAt) {
        await this.applyPlanChange(actor, (tx) =>
          tx.backupItem.update({ where: { id }, data: { removedAt: new Date() } }),
        );
      }
      if (!deleteArchives) return;
      const release = this.slot.claim('backupTask');
      try {
        await this.call(() => this.executor.backupForget(id, actor));
      } finally {
        release();
      }
      await this.applyPlanChange(actor, (tx) => tx.backupItem.delete({ where: { id } }));
    });
  }

  async archives(itemId: string): Promise<BackupArchive[]> {
    const item = await this.requireItem(itemId);
    return item.archives
      .map((name) => ({ name, createdAt: archiveTime(name) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Runs.

  /**
   * "Back up now": everything or one item. systemd runs it as its own unit (it goes on if the app
   * stops); its progress and result arrive through the wrapper's files, like a scheduled run's.
   */
  async runNow(request: BackupRunRequest, actor: ExecutorActor): Promise<{ runId: string }> {
    await this.requirePlan();
    if (request.itemId) {
      const item = await this.requireItem(request.itemId);
      if (item.removedAt) {
        throw new BadRequestException(
          error('Not backed up any more', BACKUP_ERROR_CODES.itemNotFound),
        );
      }
    }
    const release = this.slot.claim('backup');
    const runId = randomUUID();
    let handedOver = false;
    try {
      await this.prisma.backupRun.create({
        data: {
          id: runId,
          trigger: 'manual',
          itemId: request.itemId ?? null,
          status: 'running',
          startedAt: new Date(),
          startedById: actor.user.id,
        },
      });
      const outcome = await this.callRaw(() =>
        this.executor.backupStart(
          { runId, ...(request.itemId ? { itemId: request.itemId } : {}) },
          actor,
        ),
      );
      if (!outcome.ok) {
        // Nothing started: no run to show (the audit log has the request and why it failed).
        await this.prisma.backupRun.delete({ where: { id: runId } });
        throw backupError(outcome.code);
      }
      handedOver = true;
      void this.handOver(runId)
        .catch((failure: unknown) => this.logger.error(`Following run ${runId} failed`, failure))
        .finally(release);
    } finally {
      if (!handedOver) release();
    }
    this.notify();
    return { runId };
  }

  async runs(): Promise<BackupRun[]> {
    const runs = await this.prisma.backupRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: RUNS_SHOWN,
      include: { items: true },
    });
    return runs.map((run) => runView(run));
  }

  async runOutput(id: string): Promise<{ output: string[]; omitted: number }> {
    const run = await this.prisma.backupRun.findUnique({ where: { id }, select: { output: true } });
    if (!run) throw new NotFoundException(error('No such run', BACKUP_ERROR_CODES.itemNotFound));
    return { output: run.output ? run.output.split('\n') : [], omitted: 0 };
  }

  // Restores.

  async restore(
    request: BackupRestoreRequest,
    actor: ExecutorActor,
  ): Promise<{ restoreId: string; jobId: string }> {
    await this.requirePlan();
    const item = await this.requireItem(request.itemId);
    if (!item.archives.includes(request.archive)) {
      throw new NotFoundException(error('No such backup', BACKUP_ERROR_CODES.archiveNotFound));
    }
    if (request.target === 'inPlace' && item.kind !== 'service') {
      throw new BadRequestException(
        error('Only services are restored in place', BACKUP_ERROR_CODES.pathNotAllowed),
      );
    }
    const claim = this.restoreJobs.claim();
    try {
      const row = await this.prisma.backupRestore.create({
        data: {
          itemId: item.id,
          archive: request.archive,
          target: request.target,
          status: 'running',
          startedById: actor.user.id,
        },
      });
      claim.start(row.id);
      void this.executeRestore(row.id, request, actor);
      return { restoreId: row.id, jobId: row.id };
    } catch (failure) {
      claim.release();
      throw failure;
    }
  }

  async restores(): Promise<BackupRestore[]> {
    const rows = await this.prisma.backupRestore.findMany({
      orderBy: { startedAt: 'desc' },
      take: RESTORES_SHOWN,
    });
    return rows.map((row) => this.restoreJobs.view(row));
  }

  async restoreJob(id: string): Promise<BackupRestore> {
    const row = await this.prisma.backupRestore.findUnique({ where: { id } });
    if (!row)
      throw new NotFoundException(error('No such restore', BACKUP_ERROR_CODES.restoreNotFound));
    return this.restoreJobs.view(row);
  }

  /** "Delete previous version": the folders a restore in place set aside. */
  async discardPrevious(id: string, actor: ExecutorActor): Promise<BackupRestore> {
    const row = await this.prisma.backupRestore.findUnique({ where: { id } });
    if (!row || row.setAside.length === 0 || row.setAsideDeletedAt) {
      throw new NotFoundException(error('Nothing set aside', BACKUP_ERROR_CODES.restoreNotFound));
    }
    const release = this.slot.claim('backupTask');
    try {
      for (const path of row.setAside) {
        const outcome = await this.callRaw(() => this.executor.backupDiscard(path, actor));
        // Already gone (deleted by hand): fine.
        if (!outcome.ok && outcome.code !== BACKUP_ERROR_CODES.restoreNotFound) {
          throw backupError(outcome.code);
        }
      }
    } finally {
      release();
    }
    const updated = await this.prisma.backupRestore.update({
      where: { id },
      data: { setAsideDeletedAt: new Date() },
    });
    this.restoreJobs.notify();
    return this.restoreJobs.view(updated);
  }

  // The passphrase.

  /** "Show again": only with the app password; audited. */
  async passphrase(password: string, actor: ExecutorActor): Promise<{ passphrase: string }> {
    await this.requirePlan();
    await this.auth.confirmPassword(actor.user, password, actor.ip);
    return this.call(() => this.executor.backupPassphrase(actor, 'show'));
  }

  // Status (the `backups` topic).

  async status(): Promise<BackupsStatus> {
    const plan = await this.prisma.backupPlan.findUnique({ where: { id: 1 } });
    const restore = await this.prisma.backupRestore.findFirst({ orderBy: { startedAt: 'desc' } });
    const restoreView = restore ? this.restoreJobs.view(restore, TOPIC_LINES) : null;
    if (!plan) {
      return {
        configured: false,
        warnings: [],
        lastSuccessAt: null,
        nextRunAt: null,
        running: this.progress.running(),
        lastRun: null,
        items: [],
        restore: restoreView,
        lastCheck: null,
      };
    }
    const [items, lastRun, lastCheck, space, mounted] = await Promise.all([
      this.prisma.backupItem.findMany({ where: { removedAt: null }, include: itemInclude }),
      this.prisma.backupRun.findFirst({
        where: { finishedAt: { not: null } },
        orderBy: { startedAt: 'desc' },
        include: { items: true },
      }),
      this.prisma.backupCheck.findFirst({ orderBy: { finishedAt: 'desc' } }),
      this.reader.space(plan.destination),
      this.destinationMounted(plan.destination),
    ]);
    const now = new Date();
    const itemStates = items.map((item) => ({
      item,
      lastSuccess: lastSuccess(item.results),
      last: item.results[0] ?? null,
    }));
    const successes = itemStates.map((s) => s.lastSuccess);
    return {
      configured: true,
      warnings: backupWarnings({
        now,
        planCreatedAt: plan.createdAt,
        items: itemStates.map((s) => ({
          lastSuccessAt: s.lastSuccess,
          lastErrorCode: s.last?.errorCode ?? null,
        })),
        lastRun,
        lastCheck,
        destination: {
          mounted,
          totalBytes: space?.totalBytes ?? 0,
          freeBytes: space?.freeBytes ?? 0,
        },
      }),
      // Everything is backed up as of the item backed up longest ago.
      lastSuccessAt:
        successes.length > 0 && successes.every((s) => s !== null)
          ? new Date(Math.min(...successes.map((s) => s!.getTime()))).toISOString()
          : null,
      nextRunAt: nextRunAt(plan.schedule as BackupSchedule, now).toISOString(),
      running: this.progress.running(),
      lastRun: lastRun ? runView(lastRun) : null,
      items: itemStates.map(({ item, lastSuccess: success, last }) => ({
        id: item.id,
        kind: item.kind,
        serviceId: item.serviceId,
        lastSuccessAt: success?.toISOString() ?? null,
        lastStatus: last?.status ?? null,
      })),
      restore: restoreView,
      lastCheck: lastCheck
        ? {
            at: lastCheck.finishedAt.toISOString(),
            status: lastCheck.status,
            errorCode: lastCheck.errorCode,
          }
        : null,
    };
  }

  // Inside.

  /** Waits until the started run shows in the progress file, or has finished (refused at once). */
  private async handOver(runId: string): Promise<void> {
    const deadline = Date.now() + HANDOVER_MS;
    while (Date.now() < deadline) {
      await this.progress.refresh();
      if (this.progress.followedRunId() === runId) return;
      await this.results.import();
      const run = await this.prisma.backupRun.findUnique({
        where: { id: runId },
        select: { finishedAt: true },
      });
      if (!run || run.finishedAt) return;
      await new Promise((resolve) => setTimeout(resolve, HANDOVER_POLL_MS));
    }
    this.logger.warn(`Backup run ${runId} hasn't started after ${HANDOVER_MS / 1000} s`);
  }

  private async executeRestore(
    id: string,
    request: BackupRestoreRequest,
    actor: ExecutorActor,
  ): Promise<void> {
    const outcome = await this.callRaw(() =>
      this.executor.backupRestore(
        { restoreId: id, ...request },
        actor,
        this.restoreJobs.callbacks(),
      ),
    );
    await this.restoreJobs.finish(outcome);
  }

  /**
   * Changes the plan: the edits and the wrapper's `configure` of the resulting whole plan in one
   * database transaction — kept only if the wrapper accepts the plan. A refused change leaves
   * nothing behind (else every later change would resend it and fail the same way).
   */
  private async applyPlanChange(
    actor: ExecutorActor,
    edit: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await edit(tx);
        await this.configure(actor, tx);
      },
      // The wrapper checks the plan (recipes, folders) and writes two files: seconds at most.
      { timeout: 60_000 },
    );
    this.notify();
  }

  /** Writes the whole plan, as `db` sees it, through the wrapper's `configure`. */
  private async configure(actor: ExecutorActor, db: Prisma.TransactionClient): Promise<void> {
    const plan = await db.backupPlan.findUnique({ where: { id: 1 } });
    if (!plan) {
      throw new NotFoundException(
        error('Backups are not set up', BACKUP_ERROR_CODES.notConfigured),
      );
    }
    const items = await db.backupItem.findMany({
      include: itemInclude,
      orderBy: { createdAt: 'asc' },
    });
    const wrapperPlan: WrapperBackupPlan = {
      destination: plan.destination,
      schedule: plan.schedule as BackupSchedule,
      retention: plan.retention as BackupRetention,
      items: await this.wrapperItems(
        items.map((item) => ({
          id: item.id,
          kind: item.kind,
          serviceId: item.serviceId,
          path: item.path,
          excludedFields: item.excludedFields,
          removed: item.removedAt !== null,
        })),
        db,
      ),
    };
    await this.call(() => this.executor.backupConfigure(wrapperPlan, actor));
  }

  /** Items as the wrapper takes them: a service's folders from its settings, as its recipe lists them. */
  private async wrapperItems(
    rows: {
      id: string;
      kind: 'platform' | 'service' | 'folder';
      serviceId?: string | null;
      path?: string | null;
      excludedFields?: string[];
      removed?: boolean;
    }[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<WrapperBackupItem[]> {
    const serviceIds = rows.map((r) => r.serviceId).filter((id): id is string => Boolean(id));
    const services = new Map(
      (await db.service.findMany({ where: { id: { in: serviceIds } } })).map((s) => [s.id, s]),
    );
    const items: WrapperBackupItem[] = [];
    for (const row of rows) {
      const removed = row.removed ? { removed: true } : {};
      if (row.kind === 'platform') {
        items.push({ id: row.id, kind: 'platform' });
      } else if (row.kind === 'folder' && row.path) {
        items.push({ id: row.id, kind: 'folder', path: row.path, ...removed });
      } else if (row.kind === 'service' && row.serviceId) {
        const service = services.get(row.serviceId);
        const backup = service ? this.catalog.get(service.catalogId)?.meta.backup : undefined;
        if (!service || !backup) continue;
        const settings = service.settings as Record<string, unknown>;
        const folders: Record<string, string> = {};
        for (const { field } of backup.folders) {
          const value = settings[field];
          if (typeof value === 'string' && !row.excludedFields?.includes(field))
            folders[field] = value;
        }
        // Every folder switched off and still in the plan can't be: the request checks prevent it.
        if (Object.keys(folders).length === 0 && !row.removed) continue;
        items.push({
          id: row.id,
          kind: 'service',
          catalogId: service.catalogId,
          folders,
          ...removed,
        });
      }
    }
    return items;
  }

  /** New items, checked: services installed and with a backup in their recipe, folders allowed and there. */
  private async checkNewItems(
    requests: BackupItemRequest[],
    destination: string,
  ): Promise<
    (
      | { id: string; kind: 'service'; serviceId: string; excludedFields: string[] }
      | { id: string; kind: 'folder'; path: string }
    )[]
  > {
    const config = this.wrapperConfig.config;
    const problems: FieldError[] = [];
    const rows: Awaited<ReturnType<BackupManager['checkNewItems']>> = [];
    const active = await this.prisma.backupItem.findMany({ where: { removedAt: null } });
    for (const [i, request] of requests.entries()) {
      const field = `items.${i}`;
      if (request.kind === 'service') {
        const service = await this.prisma.service.findUnique({ where: { id: request.serviceId } });
        if (!service || service.status !== 'installed') {
          problems.push({ field, code: 'service_not_installed', message: 'Not installed' });
          continue;
        }
        if (!this.catalog.get(service.catalogId)?.meta.backup) {
          problems.push({
            field,
            code: BACKUP_ERROR_CODES.serviceNotBackedUp,
            message: 'Has no backup',
          });
          continue;
        }
        const excluded = request.excludedFields ?? [];
        this.checkExcluded(service.catalogId, excluded);
        const onDisk = this.serviceFolders(service.catalogId, service.settings, excluded).some(
          (folder) => inside(folder, destination) || inside(destination, folder),
        );
        if (onDisk) {
          problems.push({ field, code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'On the disk' });
          continue;
        }
        if (
          active.some((a) => a.serviceId === service.id) ||
          rows.some((r) => r.kind === 'service' && r.serviceId === service.id)
        ) {
          problems.push({
            field,
            code: BACKUP_ERROR_CODES.itemExists,
            message: 'Already backed up',
          });
          continue;
        }
        rows.push({
          id: randomUUID(),
          kind: 'service',
          serviceId: service.id,
          excludedFields: excluded,
        });
      } else {
        const path = request.path;
        if (
          !isAllowedFolder(config, path) ||
          inside(path, destination) ||
          inside(destination, path)
        ) {
          problems.push({ field, code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'Not allowed' });
          continue;
        }
        const state = await this.reader.folder(path);
        // Another user's home: the app may not look, root can read it.
        if (state === 'missing' || state === 'other') {
          problems.push({
            field,
            code: BACKUP_ERROR_CODES.pathNotFound,
            message: 'No such folder',
          });
          continue;
        }
        if (
          active.some((a) => a.path === path) ||
          rows.some((r) => r.kind === 'folder' && r.path === path)
        ) {
          problems.push({
            field,
            code: BACKUP_ERROR_CODES.itemExists,
            message: 'Already backed up',
          });
          continue;
        }
        rows.push({ id: randomUUID(), kind: 'folder', path });
      }
    }
    if (problems.length > 0) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: problems,
      } satisfies ApiErrorResponse);
    }
    if (active.length + rows.length > BACKUP_LIMITS.maxItems) {
      throw new BadRequestException(error('Too many items', BACKUP_ERROR_CODES.itemExists));
    }
    return rows;
  }

  /** A service's folders that are backed up: its recipe's backup folders, as installed, minus those switched off. */
  private serviceFolders(catalogId: string, settings: unknown, excluded: string[]): string[] {
    const backup = this.catalog.get(catalogId)?.meta.backup;
    const values = (settings ?? {}) as Record<string, unknown>;
    return (backup?.folders ?? [])
      .filter(({ field }) => !excluded.includes(field))
      .map(({ field }) => values[field])
      .filter((value): value is string => typeof value === 'string');
  }

  /** A new disk mustn't hold what's backed up onto it (the wrapper refuses that plan). */
  private async checkItemsOffDisk(destination: string): Promise<void> {
    const items = await this.prisma.backupItem.findMany({
      where: { removedAt: null },
      include: { service: true },
    });
    const folders = items.flatMap((item) =>
      item.kind === 'folder' && item.path
        ? [item.path]
        : item.service
          ? this.serviceFolders(item.service.catalogId, item.service.settings, item.excludedFields)
          : [],
    );
    if (folders.some((f) => inside(f, destination) || inside(destination, f))) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [
          {
            field: 'destination',
            code: BACKUP_ERROR_CODES.pathNotAllowed,
            message: 'Something backed up is on this disk',
          },
        ],
      } satisfies ApiErrorResponse);
    }
  }

  /** An item's backups can't be deleted while a restore's set-aside folders depend on its record. */
  private async checkNoSetAside(itemId: string): Promise<void> {
    const waiting = await this.prisma.backupRestore.count({
      where: { itemId, setAsideDeletedAt: null, NOT: { setAside: { isEmpty: true } } },
    });
    if (waiting > 0) {
      throw new ConflictException(
        error(
          'Delete the previous version kept by a restore first',
          BACKUP_ERROR_CODES.setAsideKept,
        ),
      );
    }
  }

  /** Switched-off folders: fields of the recipe's backup, never all of them. */
  private checkExcluded(catalogId: string, excluded: string[]): void {
    const backup = this.catalog.get(catalogId)?.meta.backup;
    const fields = backup?.folders.map((f) => f.field) ?? [];
    if (!excluded.every((field) => fields.includes(field)) || excluded.length >= fields.length) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [
          {
            field: 'excludedFields',
            code: BACKUP_ERROR_CODES.pathNotAllowed,
            message: 'Not a folder of this service, or all of them',
          },
        ],
      } satisfies ApiErrorResponse);
    }
  }

  /** A mounted, supported disk under /mnt or /media. */
  private async checkDestination(destination: string): Promise<void> {
    const found = (await this.destinations()).find((d) => d.mountPoint === destination);
    if (!isPlainAbsolutePath(destination) || !found || !found.supported) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [
          {
            field: 'destination',
            code: BACKUP_ERROR_CODES.destinationNotAllowed,
            message: 'Not a usable disk',
          },
        ],
      } satisfies ApiErrorResponse);
    }
  }

  private async destinationMounted(destination: string): Promise<boolean> {
    const config = this.wrapperConfig.config;
    try {
      return (await this.reader.mountPoints(mountInfoFile(config))).some(
        (p) => p.mount === destination,
      );
    } catch {
      return false;
    }
  }

  private changePlan(change: () => Promise<void>): Promise<void> {
    const next = this.planChange.then(change, change);
    this.planChange = next.catch(() => undefined);
    return next;
  }

  /** An executor call that must succeed: its result, or the matching HTTP error. */
  private async call<T>(run: () => Promise<BackupOutcome<T>>): Promise<T> {
    const outcome = await this.callRaw(run);
    if (!outcome.ok) throw backupError(outcome.code);
    return outcome.result;
  }

  /** An executor call; an audit log that couldn't record the request means nothing ran. */
  private async callRaw<T>(run: () => Promise<BackupOutcome<T>>): Promise<BackupOutcome<T>> {
    try {
      return await run();
    } catch (failure) {
      this.logger.error('Could not record the request in the audit log; nothing ran', failure);
      return { ok: false, code: BACKUP_ERROR_CODES.auditUnavailable, result: null };
    }
  }

  private async requirePlan() {
    const plan = await this.prisma.backupPlan.findUnique({ where: { id: 1 } });
    if (!plan)
      throw new NotFoundException(
        error('Backups are not set up', BACKUP_ERROR_CODES.notConfigured),
      );
    return plan;
  }

  private async requireItem(id: string): Promise<ItemRow> {
    const item = await this.prisma.backupItem.findUnique({ where: { id }, include: itemInclude });
    if (!item) throw new NotFoundException(error('No such item', BACKUP_ERROR_CODES.itemNotFound));
    return item;
  }

  private async item(id: string): Promise<BackupItem> {
    return this.itemView(await this.requireItem(id));
  }

  private itemView(item: ItemRow): BackupItem {
    const last = item.results[0];
    return {
      id: item.id,
      kind: item.kind,
      serviceId: item.serviceId,
      catalogId: item.service?.catalogId ?? null,
      path: item.path,
      excludedFields: item.excludedFields,
      removed: item.removedAt !== null,
      lastSuccessAt: lastSuccess(item.results)?.toISOString() ?? null,
      lastResult: last ? resultView(last) : null,
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** When an item was last backed up (ok or with warnings). */
function lastSuccess(results: ResultRow[]): Date | null {
  const success = results.find((r) => r.status !== 'failed');
  return success?.run.finishedAt ?? success?.run.startedAt ?? null;
}

function resultView(row: {
  itemId: string;
  status: 'ok' | 'warning' | 'failed';
  errorCode: string | null;
  archive: string | null;
  originalBytes: bigint | null;
  addedBytes: bigint | null;
  warnings: string[];
}): BackupItemResult {
  return {
    itemId: row.itemId,
    status: row.status,
    errorCode: row.errorCode,
    archive: row.archive,
    originalBytes: row.originalBytes === null ? null : Number(row.originalBytes),
    addedBytes: row.addedBytes === null ? null : Number(row.addedBytes),
    warnings: row.warnings,
  };
}

function runView(run: Prisma.BackupRunGetPayload<{ include: { items: true } }>): BackupRun {
  return {
    id: run.id,
    trigger: run.trigger,
    itemId: run.itemId,
    status: run.status,
    errorCode: run.errorCode,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    items: run.items.map(resultView),
  };
}

function error(message: string, code: BackupErrorCode): ApiErrorResponse {
  return { message, code };
}

/** A failed backup wrapper call as an HTTP error the web app can word. */
export function backupError(code: BackupErrorCode): HttpException {
  const status: Partial<Record<BackupErrorCode, HttpStatus>> = {
    [BACKUP_ERROR_CODES.busy]: HttpStatus.CONFLICT,
    [BACKUP_ERROR_CODES.repositoryExists]: HttpStatus.CONFLICT,
    [BACKUP_ERROR_CODES.pathsChanged]: HttpStatus.CONFLICT,
    [BACKUP_ERROR_CODES.setAsideKept]: HttpStatus.CONFLICT,
    [BACKUP_ERROR_CODES.invalidPlan]: HttpStatus.UNPROCESSABLE_ENTITY,
    [BACKUP_ERROR_CODES.destinationUnavailable]: HttpStatus.UNPROCESSABLE_ENTITY,
    [BACKUP_ERROR_CODES.destinationNotAllowed]: HttpStatus.UNPROCESSABLE_ENTITY,
    [BACKUP_ERROR_CODES.repositoryMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
    [BACKUP_ERROR_CODES.archiveNotFound]: HttpStatus.NOT_FOUND,
    [BACKUP_ERROR_CODES.itemNotFound]: HttpStatus.NOT_FOUND,
    [BACKUP_ERROR_CODES.executorUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
    [BACKUP_ERROR_CODES.auditUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  };
  return new HttpException(
    error('The backup could not be done', code),
    status[code] ?? HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
