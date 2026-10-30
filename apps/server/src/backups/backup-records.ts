import { NotFoundException } from '@nestjs/common';
import {
  BACKUP_ERROR_CODES,
  type BackupItem,
  type BackupItemResult,
  type BackupRun,
} from '@laris/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { apiError } from './backup-errors.js';
import { RESULTS_PER_ITEM } from './backups.constants.js';

/** An item with what its views need: its latest results. */
export const itemInclude = {
  results: {
    orderBy: { run: { startedAt: 'desc' } },
    take: RESULTS_PER_ITEM,
    include: { run: { select: { startedAt: true, finishedAt: true } } },
  },
} satisfies Prisma.BackupItemInclude;
export type ItemRow = Prisma.BackupItemGetPayload<{ include: typeof itemInclude }>;
type ResultRow = ItemRow['results'][number];

export async function requirePlan(prisma: PrismaService) {
  const plan = await prisma.backupPlan.findUnique({ where: { id: 1 } });
  if (!plan)
    throw new NotFoundException(
      apiError('Backups are not set up', BACKUP_ERROR_CODES.notConfigured),
    );
  return plan;
}

export async function requireItem(prisma: PrismaService, id: string): Promise<ItemRow> {
  const item = await prisma.backupItem.findUnique({ where: { id }, include: itemInclude });
  if (!item) throw new NotFoundException(apiError('No such item', BACKUP_ERROR_CODES.itemNotFound));
  return item;
}

/**
 * An item as the API shows it. `apps`: each Compose project's folders as Docker sees them now —
 * an app item's folders not backed up are shown as such, and an app Docker doesn't know is
 * "removed".
 */
export function itemView(item: ItemRow, apps: ReadonlyMap<string, string[]> | null): BackupItem {
  const last = item.results[0];
  const now = item.project ? apps?.get(item.project) : undefined;
  const backedUp = new Set(item.folders);
  return {
    id: item.id,
    kind: item.kind,
    project: item.project,
    folders: item.folders,
    otherFolders: (now ?? []).filter((folder) => !backedUp.has(folder)),
    skip: item.skip,
    mode: item.mode === 'stop' || item.mode === 'live' ? item.mode : null,
    appRemoved: item.kind === 'app' && apps !== null && now === undefined,
    path: item.path,
    removed: item.removedAt !== null,
    lastSuccessAt: lastSuccess(item.results)?.toISOString() ?? null,
    lastResult: last ? resultView(last) : null,
  };
}

/** When an item was last backed up (ok or with warnings). */
export function lastSuccess(results: ResultRow[]): Date | null {
  const success = results.find((r) => r.status !== 'failed');
  return success?.run.finishedAt ?? success?.run.startedAt ?? null;
}

export function runView(run: Prisma.BackupRunGetPayload<{ include: { items: true } }>): BackupRun {
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
