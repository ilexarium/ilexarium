import { BACKUP_ERROR_CODES, BACKUP_LIMITS, SERVICE_ERROR_CODES } from '@laris/shared';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { WrapperConfigService } from '../executor/wrapper-config.js';
import type { SystemReader } from '../host/system-reader.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { BackupChecks } from './backup-checks.js';

const DISK = '/mnt/backup';

function checksWith(
  active: { serviceId?: string | null; path?: string | null; removedAt?: Date | null }[],
) {
  const prisma = {
    backupItem: { findMany: vi.fn(async () => active) },
    service: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'missing'
          ? null
          : {
              id: where.id,
              status: 'installed',
              catalogId: 'navidrome',
              settings: { DATA_DIR: `/srv/laris/${where.id}` },
            },
      ),
    },
  } as unknown as PrismaService;
  const catalog = {
    get: () => ({ meta: { backup: { folders: [{ field: 'DATA_DIR' }] } } }),
  } as unknown as CatalogService;
  const config = {
    config: { storageRoots: ['/srv/laris'], protectedPaths: [] },
  } as unknown as WrapperConfigService;
  const reader = { folder: vi.fn(async () => 'readable') } as unknown as SystemReader;
  return new BackupChecks(prisma, catalog, config, reader);
}

async function problems(promise: Promise<unknown>) {
  const error = (await promise.catch((e: unknown) => e)) as {
    getResponse(): { code?: string; errors?: { field: string; code: string }[] };
  };
  return error.getResponse();
}

describe('BackupChecks.checkNewItems', () => {
  it('names each refused item by its place in the request', async () => {
    const checks = checksWith([{ serviceId: 's1' }]);
    const response = await problems(
      checks.checkNewItems(
        [
          { kind: 'service', serviceId: 's1' },
          { kind: 'service', serviceId: 'missing' },
          { kind: 'folder', path: '/etc' },
          { kind: 'folder', path: '/srv/laris/docs' },
          { kind: 'folder', path: '/srv/laris/docs' },
        ],
        DISK,
      ),
    );
    expect(response.errors).toEqual([
      expect.objectContaining({ field: 'items.0', code: BACKUP_ERROR_CODES.itemExists }),
      expect.objectContaining({ field: 'items.1', code: SERVICE_ERROR_CODES.notInstalled }),
      expect.objectContaining({ field: 'items.2', code: BACKUP_ERROR_CODES.pathNotAllowed }),
      expect.objectContaining({ field: 'items.4', code: BACKUP_ERROR_CODES.itemExists }),
    ]);
  });

  it('refuses a folder on the backup disk, or holding it', async () => {
    const checks = checksWith([]);
    const response = await problems(
      checks.checkNewItems([{ kind: 'folder', path: '/srv/laris/docs' }], '/srv/laris/docs/disk'),
    );
    expect(response.errors?.[0].code).toBe(BACKUP_ERROR_CODES.pathNotAllowed);
  });

  it('refuses more items than the plan holds, with its own code', async () => {
    const active = Array.from({ length: BACKUP_LIMITS.maxItems }, (_, i) => ({
      path: `/srv/laris/f${i}`,
    }));
    const response = await problems(
      checksWith(active).checkNewItems([{ kind: 'folder', path: '/srv/laris/new' }], DISK),
    );
    expect(response.code).toBe(BACKUP_ERROR_CODES.tooManyItems);
  });

  it('counts removed items too, as the wrapper does', async () => {
    const items = Array.from({ length: BACKUP_LIMITS.maxItems }, (_, i) => ({
      path: `/srv/laris/f${i}`,
      removedAt: i < 10 ? new Date() : null,
    }));
    const response = await problems(
      checksWith(items).checkNewItems([{ kind: 'folder', path: '/srv/laris/new' }], DISK),
    );
    expect(response.code).toBe(BACKUP_ERROR_CODES.tooManyItems);
  });

  it('counts the platform item setup adds', async () => {
    const requests = Array.from({ length: BACKUP_LIMITS.maxItems }, (_, i) => ({
      kind: 'folder' as const,
      path: `/srv/laris/f${i}`,
    }));
    const response = await problems(checksWith([]).checkNewItems(requests, DISK));
    expect(response.code).toBe(BACKUP_ERROR_CODES.tooManyItems);
  });

  it('returns the checked rows, each with a new id', async () => {
    const rows = await checksWith([]).checkNewItems(
      [
        { kind: 'service', serviceId: 's2' },
        { kind: 'folder', path: '/srv/laris/docs' },
      ],
      DISK,
    );
    expect(rows).toEqual([
      { id: expect.any(String), kind: 'service', serviceId: 's2', excludedFields: [] },
      { id: expect.any(String), kind: 'folder', path: '/srv/laris/docs' },
    ]);
  });
});
