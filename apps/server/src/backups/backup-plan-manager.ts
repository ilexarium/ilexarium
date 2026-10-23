import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BACKUP_ERROR_CODES,
  type BackupArchive,
  type BackupItem,
  type BackupItemRequest,
  type BackupPlan,
  type BackupPlanUpdate,
  type BackupRetention,
  type BackupSchedule,
  type BackupSetupRequest,
} from '@laris/shared';
import { Observable, Subject } from 'rxjs';
import { AuthService } from '../auth/auth.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type {
  BackupOutcome,
  ExecutorActor,
  WrapperBackupItem,
} from '../executor/executor.model.js';
import { ExecutorService } from '../executor/executor.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BackupChecks } from './backup-checks.js';
import { apiError, wrapperCall } from './backup-errors.js';
import { archiveTime } from './backup-paths.js';
import { itemInclude, itemView, requireItem, requirePlan } from './backup-records.js';
import { PLAN_CHANGE_TIMEOUT_MS } from './backups.constants.js';
import type { NewItemRow } from './backups.model.js';

type ItemWithService = Prisma.BackupItemGetPayload<{ include: { service: true } }>;

/**
 * The backup plan and what's in it (docs/plans/backups.md). The database is the app's truth;
 * every change of the plan, setup included, goes to the backup wrapper's `configure` inside the
 * same transaction, and is kept only if the wrapper accepts it.
 */
@Injectable()
export class BackupPlanManager {
  private readonly logger = new Logger(BackupPlanManager.name);
  private planChanges: Promise<unknown> = Promise.resolve();
  private readonly changed = new Subject<void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogService: CatalogService,
    private readonly executorService: ExecutorService,
    private readonly operationSlot: OperationSlot,
    private readonly backupChecks: BackupChecks,
    private readonly authService: AuthService,
  ) {}

  /** The plan or its items changed. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  async plan(): Promise<BackupPlan | null> {
    const plan = await this.prisma.backupPlan.findUnique({ where: { id: 1 } });
    if (!plan) return null;
    const [items, destinations] = await Promise.all([
      this.prisma.backupItem.findMany({ include: itemInclude, orderBy: { createdAt: 'asc' } }),
      this.backupChecks.destinations(),
    ]);
    return {
      destination: plan.destination,
      schedule: plan.schedule as BackupSchedule,
      retention: plan.retention as BackupRetention,
      destinationStatus: destinations.find((d) => d.mountPoint === plan.destination) ?? null,
      items: items.map((item) => itemView(item)),
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }

  /**
   * Sets backups up once: creates the repository (and its passphrase) on the chosen disk, writes
   * the plan for the timer, and returns the passphrase — shown once, to be written down.
   */
  async setup(request: BackupSetupRequest, actor: ExecutorActor): Promise<{ passphrase: string }> {
    return this.changePlan(async () => {
      if (await this.prisma.backupPlan.findUnique({ where: { id: 1 } })) {
        throw new ConflictException(
          apiError('Backups are set up already', BACKUP_ERROR_CODES.alreadyConfigured),
        );
      }
      await this.backupChecks.checkDestination(request.destination);
      const items = await this.backupChecks.checkNewItems(request.items, request.destination);
      const release = this.operationSlot.claim('backupTask');
      try {
        const init = await this.call(() =>
          this.executorService.backupInit(request.destination, actor),
        );
        await this.applyPlanChange(actor, async (tx) => {
          await tx.backupPlan.create({
            data: {
              id: 1,
              destination: request.destination,
              repositoryId: init.repositoryId,
              schedule: request.schedule,
              retention: request.retention,
            },
          });
          await tx.backupItem.createMany({
            data: [{ id: randomUUID(), kind: 'platform' as const }, ...items.map(newItemData)],
          });
        });
        return await this.call(() => this.executorService.backupPassphrase(actor, 'setup'));
      } finally {
        release();
      }
    });
  }

  /** Changes the schedule, the retention or the disk (a new disk gets a new repository). */
  async updatePlan(request: BackupPlanUpdate, actor: ExecutorActor): Promise<BackupPlan> {
    await this.changePlan(async () => {
      const plan = await requirePlan(this.prisma);
      const data: Prisma.BackupPlanUpdateInput = {};
      if (request.schedule) data.schedule = request.schedule;
      if (request.retention) data.retention = request.retention;
      const destination = request.destination;
      if (destination && destination !== plan.destination) {
        await this.backupChecks.checkDestination(destination);
        await this.backupChecks.checkItemsOffDisk(destination);
        const release = this.operationSlot.claim('backupTask');
        try {
          const init = await this.call(() => this.executorService.backupInit(destination, actor));
          data.destination = destination;
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
    const id = await this.changePlan(async () => {
      const plan = await requirePlan(this.prisma);
      const [row] = await this.backupChecks.checkNewItems([request], plan.destination);
      const removed = await this.prisma.backupItem.findFirst({
        where:
          row.kind === 'service'
            ? { kind: 'service', serviceId: row.serviceId, removedAt: { not: null } }
            : { kind: 'folder', path: row.path, removedAt: { not: null } },
      });
      await this.applyPlanChange(actor, (tx) =>
        removed
          ? tx.backupItem.update({
              where: { id: removed.id },
              data: {
                removedAt: null,
                excludedFields: row.kind === 'service' ? row.excludedFields : [],
              },
            })
          : tx.backupItem.create({ data: newItemData(row) }),
      );
      return removed?.id ?? row.id;
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
      const item = await requireItem(this.prisma, id);
      if (item.kind !== 'service' || item.removedAt) {
        throw new BadRequestException(
          apiError('Only a service’s folders can be switched off', BACKUP_ERROR_CODES.itemFixed),
        );
      }
      this.backupChecks.checkExcluded(item.service?.catalogId ?? '', excludedFields);
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
      const item = await requireItem(this.prisma, id);
      if (item.kind === 'platform') {
        throw new BadRequestException(
          apiError('The platform is always backed up', BACKUP_ERROR_CODES.itemFixed),
        );
      }
      if (deleteArchives) await this.backupChecks.checkNoSetAside(id);
      if (!item.removedAt) {
        await this.applyPlanChange(actor, (tx) =>
          tx.backupItem.update({ where: { id }, data: { removedAt: new Date() } }),
        );
      }
      if (!deleteArchives) return;
      const release = this.operationSlot.claim('backupTask');
      try {
        await this.call(() => this.executorService.backupForget(id, actor));
      } finally {
        release();
      }
      await this.applyPlanChange(actor, (tx) => tx.backupItem.delete({ where: { id } }));
    });
  }

  async archives(itemId: string): Promise<BackupArchive[]> {
    const item = await requireItem(this.prisma, itemId);
    return item.archives
      .map((name) => ({ name, createdAt: archiveTime(name) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** "Show again": only with the app password; audited. */
  async passphrase(password: string, actor: ExecutorActor): Promise<{ passphrase: string }> {
    await requirePlan(this.prisma);
    await this.authService.confirmPassword(actor.user, password, actor.ip);
    return this.call(() => this.executorService.backupPassphrase(actor, 'show'));
  }

  // Inside.

  /**
   * Plan changes one after another: each writes the whole plan. Listeners hear of it once the
   * change has finished — setup's included, passphrase and all — or failed partway.
   */
  private changePlan<T>(change: () => Promise<T>): Promise<T> {
    const next = this.planChanges.then(change, change).finally(() => this.changed.next());
    this.planChanges = next.catch(() => undefined);
    return next;
  }

  /**
   * The edits and the wrapper's `configure` of the resulting whole plan, in one database
   * transaction. A refused change leaves nothing behind (else every later change would resend it
   * and fail the same way).
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
      { timeout: PLAN_CHANGE_TIMEOUT_MS },
    );
  }

  /** Writes the whole plan, as `tx` sees it, through the wrapper's `configure`. */
  private async configure(actor: ExecutorActor, tx: Prisma.TransactionClient): Promise<void> {
    const plan = await tx.backupPlan.findUnique({ where: { id: 1 } });
    if (!plan) {
      throw new NotFoundException(
        apiError('Backups are not set up', BACKUP_ERROR_CODES.notConfigured),
      );
    }
    const items = await tx.backupItem.findMany({
      include: { service: true },
      orderBy: { createdAt: 'asc' },
    });
    await this.call(() =>
      this.executorService.backupConfigure(
        {
          destination: plan.destination,
          schedule: plan.schedule as BackupSchedule,
          retention: plan.retention as BackupRetention,
          items: items.flatMap((item) => this.wrapperItem(item) ?? []),
        },
        actor,
      ),
    );
  }

  /** An item as the wrapper takes it: a service's folders from its settings, as its recipe lists them. */
  private wrapperItem(item: ItemWithService): WrapperBackupItem | null {
    const removed = item.removedAt ? { removed: true } : {};
    if (item.kind === 'platform') return { id: item.id, kind: 'platform' };
    if (item.kind === 'folder') {
      return item.path ? { id: item.id, kind: 'folder', path: item.path, ...removed } : null;
    }
    const service = item.service;
    const backup = service ? this.catalogService.get(service.catalogId)?.meta.backup : undefined;
    if (!service || !backup) return null;
    const settings = service.settings as Record<string, unknown>;
    const folders: Record<string, string> = {};
    for (const { field } of backup.folders) {
      const value = settings[field];
      if (typeof value === 'string' && !item.excludedFields.includes(field)) folders[field] = value;
    }
    // Every folder switched off and still in the plan can't be: the request checks prevent it.
    if (Object.keys(folders).length === 0 && !item.removedAt) return null;
    return { id: item.id, kind: 'service', catalogId: service.catalogId, folders, ...removed };
  }

  private async item(id: string): Promise<BackupItem> {
    return itemView(await requireItem(this.prisma, id));
  }

  private call<T>(run: () => Promise<BackupOutcome<T>>): Promise<T> {
    return wrapperCall(this.logger, run);
  }
}

function newItemData(row: NewItemRow): Prisma.BackupItemCreateManyInput {
  return row.kind === 'service'
    ? { id: row.id, kind: 'service', serviceId: row.serviceId, excludedFields: row.excludedFields }
    : { id: row.id, kind: 'folder', path: row.path };
}
