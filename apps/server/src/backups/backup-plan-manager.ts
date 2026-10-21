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
  WrapperBackupPlan,
} from '../executor/executor.model.js';
import { ExecutorService } from '../executor/executor.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BackupChecks } from './backup-checks.js';
import { apiError, wrapperCall } from './backup-errors.js';
import { archiveTime } from './backup-paths.js';
import { itemInclude, itemView, requireItem, requirePlan } from './backup-records.js';

/**
 * The backup plan and what's in it (docs/plans/backups.md): setting up the repository, the
 * schedule, retention and disk, the items, the passphrase. The database is the app's truth; every
 * change of the plan goes to the backup wrapper's `configure`, which checks it all and writes the
 * copy the timer uses. Every privileged step goes through the executor (audited, fail closed); the
 * friendly checks (`BackupChecks`) come first.
 */
@Injectable()
export class BackupPlanManager {
  private readonly logger = new Logger(BackupPlanManager.name);
  /** Plan changes one after another: each writes the whole plan. */
  private planChange: Promise<unknown> = Promise.resolve();
  private readonly changed = new Subject<void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly executor: ExecutorService,
    private readonly slot: OperationSlot,
    private readonly checks: BackupChecks,
    private readonly auth: AuthService,
  ) {}

  /** The plan or its items changed. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  async plan(): Promise<BackupPlan | null> {
    const plan = await this.prisma.backupPlan.findUnique({ where: { id: 1 } });
    if (!plan) return null;
    const [items, destinations] = await Promise.all([
      this.prisma.backupItem.findMany({ include: itemInclude, orderBy: { createdAt: 'asc' } }),
      this.checks.destinations(),
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
    if (await this.prisma.backupPlan.findUnique({ where: { id: 1 } })) {
      throw new ConflictException(
        apiError('Backups are set up already', BACKUP_ERROR_CODES.alreadyConfigured),
      );
    }
    await this.checks.checkDestination(request.destination);
    const items = await this.checks.checkNewItems(request.items, request.destination);
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
      const plan = await requirePlan(this.prisma);
      const data: Prisma.BackupPlanUpdateInput = {};
      if (request.schedule) data.schedule = request.schedule;
      if (request.retention) data.retention = request.retention;
      if (request.destination && request.destination !== plan.destination) {
        await this.checks.checkDestination(request.destination);
        await this.checks.checkItemsOffDisk(request.destination);
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
      const plan = await requirePlan(this.prisma);
      const [row] = await this.checks.checkNewItems([request], plan.destination);
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
      const item = await requireItem(this.prisma, id);
      if (item.kind !== 'service' || item.removedAt) {
        throw new BadRequestException(
          apiError('Only a service’s folders can be switched off', BACKUP_ERROR_CODES.itemFixed),
        );
      }
      this.checks.checkExcluded(item.service?.catalogId ?? '', excludedFields);
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
      if (deleteArchives) await this.checks.checkNoSetAside(id);
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
    const item = await requireItem(this.prisma, itemId);
    return item.archives
      .map((name) => ({ name, createdAt: archiveTime(name) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // The passphrase.

  /** "Show again": only with the app password; audited. */
  async passphrase(password: string, actor: ExecutorActor): Promise<{ passphrase: string }> {
    await requirePlan(this.prisma);
    await this.auth.confirmPassword(actor.user, password, actor.ip);
    return this.call(() => this.executor.backupPassphrase(actor, 'show'));
  }

  // Inside.

  private changePlan(change: () => Promise<void>): Promise<void> {
    const next = this.planChange.then(change, change);
    this.planChange = next.catch(() => undefined);
    return next;
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
        apiError('Backups are not set up', BACKUP_ERROR_CODES.notConfigured),
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

  private async item(id: string): Promise<BackupItem> {
    return itemView(await requireItem(this.prisma, id));
  }

  private call<T>(run: () => Promise<BackupOutcome<T>>): Promise<T> {
    return wrapperCall(this.logger, run);
  }

  private notify(): void {
    this.changed.next();
  }
}
