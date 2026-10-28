import type { PrismaService } from '../prisma/prisma.service.js';
import type { RootPrograms } from '../root-programs/root-programs.js';
import { BackupRuns } from './backup-runs.js';

const actor = { user: { id: 'u1', username: 'alice' }, ip: '127.0.0.1', appSessionId: 's1' } as never;

function setUp(start: () => Promise<unknown>) {
  const prisma = {
    backupPlan: { findUnique: vi.fn(async () => ({ id: 1 })) },
    backupRun: {
      create: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
  } as unknown as PrismaService;
  const rootPrograms = { backupStart: vi.fn(start) } as unknown as RootPrograms;
  return { runs: new BackupRuns(prisma, rootPrograms), prisma, rootPrograms };
}

describe('BackupRuns.runNow', () => {
  it('records the run, then starts it through the person’s sudo', async () => {
    const { runs, prisma, rootPrograms } = setUp(async () => ({ ok: true, result: null }));
    const { runId } = await runs.runNow({}, actor);
    expect(prisma.backupRun.create).toHaveBeenCalledOnce();
    expect(rootPrograms.backupStart).toHaveBeenCalledWith({ runId }, actor);
  });

  it('forgets the run when it didn’t start (the program refused)', async () => {
    const { runs, prisma } = setUp(async () => ({ ok: false, code: 'busy', result: null }));
    await expect(runs.runNow({}, actor)).rejects.toMatchObject({ status: 409 });
    expect(prisma.backupRun.delete).toHaveBeenCalledOnce();
  });

  it('forgets it too when sudo said no (locked): the web app asks and tries again', async () => {
    const locked = Object.assign(new Error('sudo'), { status: 403 });
    const { runs, prisma } = setUp(async () => {
      throw locked;
    });
    await expect(runs.runNow({}, actor)).rejects.toBe(locked);
    expect(prisma.backupRun.delete).toHaveBeenCalledOnce();
  });
});
