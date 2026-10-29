import { BACKUP_ERROR_CODES, BACKUP_LIMITS } from '@laris/shared';
import type { DockerService } from '../docker/docker.service.js';
import type { SystemReader } from '../host/system-reader.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ProgramConfigService } from '../root-programs/program-config.js';
import { BackupChecks } from './backup-checks.js';

const DISK = '/mnt/backup';
const APP = { kind: 'app' as const, folders: [], skip: [], mode: 'stop' as const };

function checksWith(
  active: { project?: string | null; path?: string | null; removedAt?: Date | null }[],
) {
  const prisma = {
    backupItem: { findMany: vi.fn(async () => active) },
  } as unknown as PrismaService;
  const config = {
    config: { protectedPaths: ['/var/lib/laris'] },
  } as unknown as ProgramConfigService;
  const reader = { folder: vi.fn(async () => 'folder') } as unknown as SystemReader;
  const docker = {
    appFolders: vi.fn(
      async () =>
        new Map([
          // System files an app mounts too are never offered for its backup.
          ['immich', ['/etc/localtime', '/home/anna/apps/immich', '/var/run/docker.sock']],
          ['music', ['/home/anna/apps/music', '/mnt/usb/music']],
        ]),
    ),
  } as unknown as DockerService;
  return new BackupChecks(prisma, config, reader, docker);
}

async function problems(promise: Promise<unknown>) {
  const error = (await promise.catch((e: unknown) => e)) as {
    getResponse(): { code?: string; errors?: { field: string; code: string }[] };
  };
  return error.getResponse();
}

describe('BackupChecks.checkNewItems', () => {
  it('names each refused item by its place in the request', async () => {
    const checks = checksWith([{ project: 'immich' }]);
    const response = await problems(
      checks.checkNewItems(
        [
          { ...APP, project: 'immich' },
          { ...APP, project: 'missing' },
          { kind: 'folder', path: '/etc' },
          { kind: 'folder', path: '/srv/laris/docs' },
          { kind: 'folder', path: '/srv/laris/docs' },
        ],
        DISK,
      ),
    );
    expect(response.errors).toEqual([
      expect.objectContaining({ field: 'items.0', code: BACKUP_ERROR_CODES.itemExists }),
      expect.objectContaining({ field: 'items.1', code: BACKUP_ERROR_CODES.itemNotFound }),
      expect.objectContaining({ field: 'items.2', code: BACKUP_ERROR_CODES.pathNotAllowed }),
      expect.objectContaining({ field: 'items.4', code: BACKUP_ERROR_CODES.itemExists }),
    ]);
  });

  it('refuses an app skip outside its folders, and an app folder on the disk', async () => {
    const outside = await problems(
      checksWith([]).checkNewItems([{ ...APP, project: 'immich', skip: ['/srv/x'] }], DISK),
    );
    expect(outside.errors?.[0].code).toBe(BACKUP_ERROR_CODES.pathNotAllowed);
    const onDisk = await problems(
      checksWith([]).checkNewItems([{ ...APP, project: 'music' }], '/mnt/usb'),
    );
    expect(onDisk.errors?.[0].code).toBe(BACKUP_ERROR_CODES.pathNotAllowed);
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

  it('an app without folders asked: Docker’s, but never a system path it mounts', async () => {
    const [row] = await checksWith([]).checkNewItems([{ ...APP, project: 'immich' }], DISK);
    expect(row).toMatchObject({ kind: 'app', folders: ['/home/anna/apps/immich'] });
  });

  it('returns the checked rows, each with a new id', async () => {
    const rows = await checksWith([]).checkNewItems(
      [
        {
          ...APP,
          project: 'music',
          excludedFolders: ['/mnt/usb/music'],
          skip: ['/home/anna/apps/music/cache'],
        },
        { kind: 'folder', path: '/srv/laris/docs' },
      ],
      DISK,
    );
    expect(rows).toEqual([
      {
        id: expect.any(String),
        kind: 'app',
        project: 'music',
        // No folders asked: Docker's, but those left out.
        folders: ['/home/anna/apps/music'],
        excludedFolders: ['/mnt/usb/music'],
        skip: ['/home/anna/apps/music/cache'],
        mode: 'stop',
      },
      { id: expect.any(String), kind: 'folder', path: '/srv/laris/docs' },
    ]);
  });
});
