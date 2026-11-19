import { BACKUP_ERROR_CODES, FILES_ERROR_CODES } from '@ilex/shared';
import { constants } from 'node:fs';
import type { DockerService } from '../docker/docker.service.js';
import type { SystemReader } from '../host/system-reader.js';
import { linuxError } from '../linux-sessions/linux-session-errors.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ProgramConfigService } from '../root-programs/program-config.js';
import { BackupChecks } from './backup-checks.js';

const APP = { kind: 'app' as const, folders: [], skip: [], mode: 'stop' as const };
const DISK = '/mnt/backups';

/** What the signed-in account sees over SFTP: each readable folder's entries; others refused. */
type Tree = Record<string, { name: string; folder: boolean }[] | 'denied'>;

function checksWith(
  active: { project?: string | null; path?: string | null; removedAt?: Date | null }[],
  tree: Tree | null = {},
) {
  const prisma = {
    backupItem: { findMany: vi.fn(async () => active) },
  } as unknown as PrismaService;
  const config = {
    config: { protectedPaths: ['/var/lib/ilex'] },
  } as unknown as ProgramConfigService;
  const reader = { folder: vi.fn(async () => 'folder') } as unknown as SystemReader;
  const docker = {
    appFolders: vi.fn(
      async () =>
        new Map([
          // System files an app mounts too are never offered for its backup.
          ['immich', ['/etc/localtime', '/home/anna/apps/immich', '/var/run/docker.sock']],
          ['music', ['/home/anna/apps/music', '/mnt/usb/music']],
          // A folder on the backup disk is left out of what's suggested, not a reason to refuse.
          ['media', ['/home/anna/apps/media', '/mnt/backups/media']],
        ]),
    ),
  } as unknown as DockerService;
  const mode = (folder: boolean) => (folder ? constants.S_IFDIR : constants.S_IFREG) | 0o755;
  const sftp = {
    entries: vi.fn(async (path: string) => {
      const entries = tree?.[path];
      if (entries === undefined) throw linuxError(FILES_ERROR_CODES.notFound, 'Not found');
      if (entries === 'denied') throw linuxError(FILES_ERROR_CODES.permissionDenied, 'Denied');
      return entries.map(({ name, folder }) => ({ filename: name, attrs: { mode: mode(folder) } }));
    }),
    statOrNull: vi.fn(async (path: string) => (tree?.[path] !== undefined ? {} : null)),
  };
  const linuxSessions = {
    sftp: vi.fn(() => {
      if (!tree) throw linuxError(FILES_ERROR_CODES.linuxSessionRequired, 'Sign in');
      return { sftp, username: 'anna' };
    }),
  } as unknown as LinuxSessions;
  return new BackupChecks(prisma, config, reader, docker, linuxSessions);
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
          { kind: 'folder', path: '/srv/ilex/docs' },
          { kind: 'folder', path: '/srv/ilex/docs' },
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
          skip: ['/home/anna/apps/music/cache'],
        },
        { kind: 'folder', path: '/srv/ilex/docs' },
      ],
      DISK,
    );
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
      { id: expect.any(String), kind: 'folder', path: '/srv/ilex/docs' },
    ]);
  });

  it('refuses the backup disk itself, a folder on it or one holding it — the disk can’t back itself up', async () => {
    const response = await problems(
      checksWith([]).checkNewItems(
        [
          { kind: 'folder', path: DISK },
          { kind: 'folder', path: `${DISK}/old` },
          { kind: 'folder', path: '/mnt' },
          { kind: 'folder', path: '/mnt/backups-2' },
          { ...APP, project: 'music', folders: ['/home/anna/apps/music', `${DISK}/music`] },
        ],
        DISK,
      ),
    );
    const code = BACKUP_ERROR_CODES.pathOnBackupDisk;
    expect(response.errors).toEqual([
      expect.objectContaining({ field: 'items.0', code }),
      expect.objectContaining({ field: 'items.1', code }),
      expect.objectContaining({ field: 'items.2', code }),
      expect.objectContaining({ field: 'items.4', code }),
    ]);
  });

  it('an app without folders asked: Docker’s, but none on the backup disk', async () => {
    const [row] = await checksWith([]).checkNewItems([{ ...APP, project: 'media' }], DISK);
    expect(row).toMatchObject({ kind: 'app', folders: ['/home/anna/apps/media'] });
  });

  it('refuses a restore into the backup disk', () => {
    const checks = checksWith([]);
    expect(() => checks.checkRestoreTarget(`${DISK}/restored`, DISK)).toThrow();
    expect(() => checks.checkRestoreTarget('/srv/restored', DISK)).not.toThrow();
  });

  it('refuses moving the backups to a disk an item is on', async () => {
    const checks = checksWith([
      { kind: 'folder', path: '/mnt/disk2/photos', folders: [] },
      { kind: 'app', path: null, folders: ['/home/anna/apps/music'] },
    ] as never);
    const response = await problems(checks.checkItemsOffDisk('/mnt/disk2'));
    expect(response.errors).toEqual([
      expect.objectContaining({ field: 'destination', code: BACKUP_ERROR_CODES.pathOnBackupDisk }),
    ]);
    await expect(checks.checkItemsOffDisk('/mnt/disk3')).resolves.toBeUndefined();
  });

  it('refuses an app’s folders changed to one on the backup disk', () => {
    expect(() =>
      checksWith([]).checkAppChange(
        { folders: ['/home/anna/apps/music'] },
        { folders: [`${DISK}/x`] },
        DISK,
      ),
    ).toThrow();
  });
});

describe('BackupChecks.folders (as the signed-in Linux account)', () => {
  const tree: Tree = {
    '/home': [
      { name: 'anna', folder: true },
      { name: 'bob', folder: true },
      { name: 'notes.txt', folder: false },
    ],
    // Private homes: anna's opens for anna, bob's doesn't.
    '/home/anna': [
      { name: 'Photos', folder: true },
      { name: '.config', folder: true },
      { name: 'todo.md', folder: false },
    ],
    '/home/bob': 'denied',
    '/srv': [],
  };

  it('the starting places: the homes and the places that exist, as the account sees them', async () => {
    const checks = checksWith([], tree);
    vi.spyOn(checks, 'destinations').mockResolvedValue([]);
    const listing = await checks.folders('s1');
    expect(listing.folders.map((f) => f.path)).toEqual(['/home/anna', '/home/bob', '/srv']);
  });

  it('inside a private home the account owns: its folders, not its files', async () => {
    const listing = await checksWith([], tree).folders('s1', '/home/anna');
    expect(listing).toMatchObject({ path: '/home/anna', parent: '/home', readable: true });
    expect(listing.folders.map((f) => f.name)).toEqual(['.config', 'Photos']);
  });

  it('another account’s private home: unreadable, not an error', async () => {
    const listing = await checksWith([], tree).folders('s1', '/home/bob');
    expect(listing).toMatchObject({ readable: false, folders: [] });
  });

  it('a system folder: refused before anything is read', async () => {
    const checks = checksWith([], tree);
    expect((await problems(checks.folders('s1', '/var/lib/ilex'))).code).toBe(
      BACKUP_ERROR_CODES.pathNotAllowed,
    );
  });

  it('without a Linux session: linux_session_required (the page asks for the sign-in)', async () => {
    const checks = checksWith([], null);
    expect((await problems(checks.folders('s1', '/home/anna'))).code).toBe(
      FILES_ERROR_CODES.linuxSessionRequired,
    );
    expect((await problems(checks.folders('s1'))).code).toBe(
      FILES_ERROR_CODES.linuxSessionRequired,
    );
  });
});
