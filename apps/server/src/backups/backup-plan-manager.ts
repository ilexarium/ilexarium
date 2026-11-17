import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BACKUP_ARCHIVE_PATTERN,
  BACKUP_ERROR_CODES,
  type BackupArchive,
  type BackupItem,
  type BackupItemRequest,
  type BackupItemUpdate,
  type BackupPlan,
  type BackupPlanUpdate,
  type BackupRetention,
  type BackupSchedule,
  type BackupSetupRequest,
} from '@ilex/shared';
import { Observable, Subject } from 'rxjs';
import type { BackupItem as BackupItemRow, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProgramBackupItem, RootActor } from '../root-programs/root-programs.model.js';
import { RootPrograms } from '../root-programs/root-programs.js';
import { BackupChecks } from './backup-checks.js';
import { apiError, programCall } from './backup-errors.js';
import { archiveTime } from './backup-paths.js';
import { itemInclude, itemView, requireItem, requirePlan } from './backup-records.js';
import { PLAN_CHANGE_TIMEOUT_MS } from './backups.constants.js';
import type { NewItemRow } from './backups.model.js';

/**
 * The backup plan and what's in it. The database is the
 * app's truth; every change of the plan, setup included, goes to the backup program's `configure`
 * — through the person's sudo — inside the same transaction, and is kept only if it accepts it.
 */
@Injectable()
export class BackupPlanManager {
  private planChanges: Promise<unknown> = Promise.resolve();
  private readonly changed = new Subject<void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rootPrograms: RootPrograms,
    private readonly backupChecks: BackupChecks,
  ) {}

  /** The plan or its items changed. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  async plan(): Promise<BackupPlan | null> {
    const plan = await this.prisma.backupPlan.findUnique({ where: { id: 1 } });
    if (!plan) return null;
    const [items, destinations, apps] = await Promise.all([
      this.prisma.backupItem.findMany({ include: itemInclude, orderBy: { createdAt: 'asc' } }),
      this.backupChecks.destinations(),
      this.appFolders(),
    ]);
    return {
      destination: plan.destination,
      schedule: plan.schedule as BackupSchedule,
      retention: plan.retention as BackupRetention,
      destinationStatus: destinations.find((d) => d.mountPoint === plan.destination) ?? null,
      items: items.map((item) => itemView(item, apps)),
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }

  /**
   * Sets backups up once: creates the repository (and its passphrase) on the chosen disk, writes
   * the plan for the timer, and returns the passphrase — shown once, to be written down.
   */
  async setup(request: BackupSetupRequest, actor: RootActor): Promise<{ passphrase: string }> {
    return this.changePlan(async () => {
      if (await this.prisma.backupPlan.findUnique({ where: { id: 1 } })) {
        throw new ConflictException(
          apiError('Backups are set up already', BACKUP_ERROR_CODES.alreadyConfigured),
        );
      }
      await this.backupChecks.checkDestination(request.destination);
      const items = await this.backupChecks.checkNewItems(request.items);
      const init = await programCall(() =>
        this.rootPrograms.backupInit(request.destination, actor),
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
      return programCall(() => this.rootPrograms.backupPassphrase(actor, 'setup'));
    });
  }

  /** Changes the schedule, the retention or the disk (a new disk gets a new repository). */
  async updatePlan(request: BackupPlanUpdate, actor: RootActor): Promise<BackupPlan> {
    await this.changePlan(async () => {
      const plan = await requirePlan(this.prisma);
      const data: Prisma.BackupPlanUpdateInput = {};
      if (request.schedule) data.schedule = request.schedule;
      if (request.retention) data.retention = request.retention;
      const destination = request.destination;
      if (destination && destination !== plan.destination) {
        await this.backupChecks.checkDestination(destination);
        const init = await programCall(() => this.rootPrograms.backupInit(destination, actor));
        data.destination = destination;
        data.repositoryId = init.repositoryId;
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

  /** Adds an app or a folder (one removed earlier comes back, with its archives). */
  async addItem(request: BackupItemRequest, actor: RootActor): Promise<BackupItem> {
    const id = await this.changePlan(async () => {
      await requirePlan(this.prisma);
      const [row] = await this.backupChecks.checkNewItems([request]);
      const removed = await this.prisma.backupItem.findFirst({
        where:
          row.kind === 'app'
            ? { kind: 'app', project: row.project, removedAt: { not: null } }
            : { kind: 'folder', path: row.path, removedAt: { not: null } },
      });
      await this.applyPlanChange(actor, (tx) =>
        removed
          ? tx.backupItem.update({
              where: { id: removed.id },
              data: {
                removedAt: null,
                ...(row.kind === 'app' && {
                  folders: row.folders,
                  skip: row.skip,
                  mode: row.mode,
                }),
              },
            })
          : tx.backupItem.create({ data: newItemData(row) }),
      );
      return removed?.id ?? row.id;
    });
    return this.item(id);
  }

  /** An app item's folders, skips or mode. */
  async updateItem(id: string, change: BackupItemUpdate, actor: RootActor): Promise<BackupItem> {
    await this.changePlan(async () => {
      await requirePlan(this.prisma);
      const item = await requireItem(this.prisma, id);
      if (item.kind !== 'app' || item.removedAt) {
        throw new BadRequestException(
          apiError('Only an app’s folders can be changed', BACKUP_ERROR_CODES.itemFixed),
        );
      }
      this.backupChecks.checkAppChange(item, change);
      await this.applyPlanChange(actor, (tx) =>
        tx.backupItem.update({
          where: { id },
          data: {
            ...(change.folders && { folders: [...new Set(change.folders)] }),
            ...(change.skip && { skip: [...new Set(change.skip)] }),
            ...(change.mode && { mode: change.mode }),
          },
        }),
      );
    });
    return this.item(id);
  }

  /**
   * Takes an item out of the plan; its archives stay — unless `deleteArchives` (confirmed in the
   * browser), then they're deleted and the item is gone. The platform always stays.
   */
  async removeItem(id: string, deleteArchives: boolean, actor: RootActor): Promise<void> {
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
      await programCall(() => this.rootPrograms.backupForget(id, actor));
      await this.applyPlanChange(actor, (tx) => tx.backupItem.delete({ where: { id } }));
    });
  }

  async archives(itemId: string): Promise<BackupArchive[]> {
    const item = await requireItem(this.prisma, itemId);
    return item.archives
      .map((name) => ({ name, createdAt: archiveTime(name) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Each item's archives read from the repository, through the person's sudo: the saved lists are
   * from the last run the app saw, a run behind after its database was restored.
   */
  async refreshArchives(actor: RootActor): Promise<void> {
    await requirePlan(this.prisma);
    const { archives } = await programCall(() => this.rootPrograms.backupList(actor));
    const items = await this.prisma.backupItem.findMany({ select: { id: true } });
    const now = new Date();
    await this.prisma.$transaction(
      items
        .filter(({ id }) => archives[id])
        .map(({ id }) =>
          this.prisma.backupItem.update({
            where: { id },
            data: {
              archives: archives[id].filter(
                (name) => name.startsWith(`${id}-`) && BACKUP_ARCHIVE_PATTERN.test(name),
              ),
              archivesAt: now,
            },
          }),
        ),
    );
  }

  /** "Show again": through the person's sudo; audited. */
  async passphrase(actor: RootActor): Promise<{ passphrase: string }> {
    await requirePlan(this.prisma);
    return programCall(() => this.rootPrograms.backupPassphrase(actor, 'show'));
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
    actor: RootActor,
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

  /** Writes the whole plan, as `tx` sees it, through the program's `configure`. */
  private async configure(actor: RootActor, tx: Prisma.TransactionClient): Promise<void> {
    const plan = await tx.backupPlan.findUnique({ where: { id: 1 } });
    if (!plan) {
      throw new NotFoundException(
        apiError('Backups are not set up', BACKUP_ERROR_CODES.notConfigured),
      );
    }
    const items = await tx.backupItem.findMany({ orderBy: { createdAt: 'asc' } });
    await programCall(() =>
      this.rootPrograms.backupConfigure(
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

  /** An item as the program takes it. */
  private wrapperItem(item: BackupItemRow): ProgramBackupItem | null {
    const removed = item.removedAt ? { removed: true } : {};
    if (item.kind === 'platform') return { id: item.id, kind: 'platform' };
    if (item.kind === 'folder') {
      return item.path ? { id: item.id, kind: 'folder', path: item.path, ...removed } : null;
    }
    if (!item.project || (item.folders.length === 0 && !item.removedAt)) return null;
    return {
      id: item.id,
      kind: 'app',
      project: item.project,
      folders: item.folders,
      skip: item.skip,
      mode: item.mode === 'live' ? 'live' : 'stop',
      ...removed,
    };
  }

  /** Each app's folders as Docker sees them now (null: Docker didn't answer). */
  private appFolders(): Promise<Map<string, string[]> | null> {
    return this.backupChecks.appFolders();
  }

  private async item(id: string): Promise<BackupItem> {
    return itemView(await requireItem(this.prisma, id), await this.appFolders());
  }
}

function newItemData(row: NewItemRow): Prisma.BackupItemCreateManyInput {
  return row.kind === 'app'
    ? {
        id: row.id,
        kind: 'app',
        project: row.project,
        folders: row.folders,
        skip: row.skip,
        mode: row.mode,
      }
    : { id: row.id, kind: 'folder', path: row.path };
}
