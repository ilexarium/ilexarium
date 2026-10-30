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
