import type { AppManager } from '../apps/app-manager.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RootPrograms } from '../root-programs/root-programs.js';
import type { BackupChecks } from './backup-checks.js';
import type { BackupJobs } from './backup-jobs.js';
import { BackupRestores } from './backup-restores.js';

const ID = '66666666-6666-4666-8666-666666666666';
const ACTOR = { user: { id: 'u1' }, appSessionId: 's1' } as never;

function setUp(row: Record<string, unknown> | null) {
  const update = vi.fn(async () => undefined);
  const apply = vi.fn(async () => ({ name: 'music', folder: '/home/anna/apps/music', task: null }));
  const restores = new BackupRestores(
    { backupRestore: { findUnique: vi.fn(async () => row), update } } as unknown as PrismaService,
    {} as RootPrograms,
    {} as BackupChecks,
    {} as BackupJobs,
    { apply } as unknown as AppManager,
  );
  return { restores, update, apply };
}

const offered = {
  status: 'succeeded',
  appWasRunning: true,
  item: { project: 'music' },
};

describe('BackupRestores.restore', () => {
  it('a folder another account can change: the program’s refusal at once, as 422 with its code, no row kept', async () => {
    const remove = vi.fn(async () => undefined);
    const prisma = {
      backupPlan: { findUnique: vi.fn(async () => ({ id: 1 })) },
      backupItem: { findUnique: vi.fn(async () => ({ id: 'i1', archives: ['a1'] })) },
      backupRestore: { create: vi.fn(async () => ({ id: ID })), delete: remove },
    } as unknown as PrismaService;
    const rootPrograms = {
      backupRestoreStart: vi.fn(async () => ({
        ok: false,
        code: 'path_others_can_change',
        result: null,
      })),
    } as unknown as RootPrograms;
    const restores = new BackupRestores(
      prisma,
      rootPrograms,
      { checkRestoreTarget: () => undefined } as unknown as BackupChecks,
      {} as BackupJobs,
      {} as AppManager,
    );
    await expect(
      restores.restore({ itemId: 'i1', archive: 'a1', target: '/home/bob/restored' }, ACTOR),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'path_others_can_change' },
    });
    expect(remove).toHaveBeenCalledWith({ where: { id: ID } });
  });
});

describe('BackupRestores.apply', () => {
  it('runs the restored app’s up task as the person, then offers it no more', async () => {
    const { restores, update, apply } = setUp(offered);
    await restores.apply(ID, '/home/anna/apps/music', ACTOR);
    expect(apply).toHaveBeenCalledWith('s1', 'music', '/home/anna/apps/music', ACTOR);
    expect(update).toHaveBeenCalledWith({ where: { id: ID }, data: { appWasRunning: false } });
  });

  it.each([
    ['not offered (used already, or the app wasn’t running)', { ...offered, appWasRunning: false }],
    ['a restore that failed', { ...offered, status: 'failed' }],
    ['a folder’s restore', { ...offered, item: { project: null } }],
    ['no such restore', null],
  ])('refuses %s', async (_, row) => {
    const { restores, apply } = setUp(row);
    await expect(restores.apply(ID, '/x', ACTOR)).rejects.toMatchObject({ status: 404 });
    expect(apply).not.toHaveBeenCalled();
  });
});
