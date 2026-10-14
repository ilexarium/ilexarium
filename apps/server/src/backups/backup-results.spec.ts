import type { AuditService } from '../audit/audit.service.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { BackupFiles } from './backup-files.js';
import { BackupProgressFollower } from './backup-progress.js';
import { BackupResults } from './backup-results.js';

const RUN = '55555555-5555-4555-8555-555555555555';
const DEAD_PID = 2 ** 22 + 12345; // above the usual pid limit: no such process

describe('BackupResults', () => {
  it('records a run that crashed even when the follower finds it during startup', async () => {
    const text = `${JSON.stringify({
      type: 'run',
      runId: RUN,
      trigger: 'manual',
      itemId: null,
      pid: DEAD_PID,
      startedAt: new Date().toISOString(),
      items: [],
    })}\n`;
    const files = {
      progressFrom: async (from: number) => ({
        text: text.slice(from),
        size: text.length,
        file: '1',
      }),
      onChange: () => () => undefined,
      results: async () => [],
    } as unknown as BackupFiles;
    const upsert = vi.fn(async () => undefined);
    const prisma = {
      backupRun: { findUnique: vi.fn(async () => null), upsert },
      backupItem: { findMany: vi.fn(async () => []) },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
    } as unknown as PrismaService;
    const follower = new BackupProgressFollower(files, new OperationSlot());
    new BackupResults(prisma, files, {} as AuditService, follower);
    // The follower's startup read (onModuleInit) — before any onApplicationBootstrap.
    await follower.refresh();
    await vi.waitFor(() => expect(upsert).toHaveBeenCalled());
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: RUN },
        create: expect.objectContaining({ status: 'failed', errorCode: 'interrupted' }),
      }),
    );
  });
});
