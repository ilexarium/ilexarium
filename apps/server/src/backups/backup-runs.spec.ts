import type { PrismaService } from '../prisma/prisma.service.js';
import type { RootPrograms } from '../root-programs/root-programs.js';
import { BackupRuns } from './backup-runs.js';

const actor = {
  user: { id: 'u1', username: 'alice' },
  ip: '127.0.0.1',
  appSessionId: 's1',
} as never;

function setUp(start: () => Promise<unknown>) {
  const backupRun = {
    create: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const backupStart = vi.fn(start);
  const prisma = {
    backupPlan: { findUnique: vi.fn(async () => ({ id: 1 })) },
    backupRun,
  } as unknown as PrismaService;
  const rootPrograms = { backupStart } as unknown as RootPrograms;
  return { runs: new BackupRuns(prisma, rootPrograms), backupRun, backupStart };
}

describe('BackupRuns.runNow', () => {
  it('records the run, then starts it through the person’s sudo', async () => {
    const { runs, backupRun, backupStart } = setUp(async () => ({ ok: true, result: null }));
    const { runId } = await runs.runNow({}, actor);
    expect(backupRun.create).toHaveBeenCalledOnce();
    expect(backupStart).toHaveBeenCalledWith({ runId }, actor);
  });

  it('forgets the run when it didn’t start (the program refused)', async () => {
    const { runs, backupRun } = setUp(async () => ({ ok: false, code: 'busy', result: null }));
    await expect(runs.runNow({}, actor)).rejects.toMatchObject({ status: 409 });
    expect(backupRun.delete).toHaveBeenCalledOnce();
  });

  it('forgets it too when sudo said no (locked): the web app asks and tries again', async () => {
    const locked = Object.assign(new Error('sudo'), { status: 403 });
    const { runs, backupRun } = setUp(async () => {
      throw locked;
    });
    await expect(runs.runNow({}, actor)).rejects.toBe(locked);
    expect(backupRun.delete).toHaveBeenCalledOnce();
  });
});
