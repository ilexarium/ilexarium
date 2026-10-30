import { BACKUP_ERROR_CODES } from '@laris/shared';
import type { DockerService } from '../docker/docker.service.js';
import type { SystemReader } from '../host/system-reader.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ProgramConfigService } from '../root-programs/program-config.js';
import { BackupChecks } from './backup-checks.js';

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
      checks.checkNewItems([
        { ...APP, project: 'immich' },
        { ...APP, project: 'missing' },
        { kind: 'folder', path: '/etc' },
        { kind: 'folder', path: '/srv/laris/docs' },
        { kind: 'folder', path: '/srv/laris/docs' },
      ]),
    );
    expect(response.errors).toEqual([
      expect.objectContaining({ field: 'items.0', code: BACKUP_ERROR_CODES.itemExists }),
      expect.objectContaining({ field: 'items.1', code: BACKUP_ERROR_CODES.itemNotFound }),
      expect.objectContaining({ field: 'items.2', code: BACKUP_ERROR_CODES.pathNotAllowed }),
      expect.objectContaining({ field: 'items.4', code: BACKUP_ERROR_CODES.itemExists }),
    ]);
  });

  it('an app without folders asked: Docker’s, but never a system path it mounts', async () => {
    const [row] = await checksWith([]).checkNewItems([{ ...APP, project: 'immich' }]);
    expect(row).toMatchObject({ kind: 'app', folders: ['/home/anna/apps/immich'] });
  });

  it('returns the checked rows, each with a new id', async () => {
    const rows = await checksWith([]).checkNewItems([
      {
        ...APP,
        project: 'music',
        skip: ['/home/anna/apps/music/cache'],
      },
      { kind: 'folder', path: '/srv/laris/docs' },
    ]);
    expect(rows).toEqual([
      {
        id: expect.any(String),
        kind: 'app',
        project: 'music',
        // No folders asked: all of Docker's.
        folders: ['/home/anna/apps/music', '/mnt/usb/music'],
        skip: ['/home/anna/apps/music/cache'],
        mode: 'stop',
      },
      { id: expect.any(String), kind: 'folder', path: '/srv/laris/docs' },
    ]);
  });
});
