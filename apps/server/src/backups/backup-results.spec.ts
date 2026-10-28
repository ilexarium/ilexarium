import type { AuditService } from '../audit/audit.service.js';
import { NEVER } from 'rxjs';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { BackupFiles } from './backup-files.js';
import { BackupProgressFollower } from './backup-progress.js';
import { BackupResults } from './backup-results.js';
import { START_GRACE_MS } from './backups.constants.js';

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
      changes$: NEVER,
      results: async () => [],
    } as unknown as BackupFiles;
    const upsert = vi.fn(async () => undefined);
    const prisma = {
      backupRun: { findUnique: vi.fn(async () => null), upsert },
      backupItem: { findMany: vi.fn(async () => []) },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
    } as unknown as PrismaService;
    const follower = new BackupProgressFollower(files, new ChangesUnderway());
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

  function setUp(results: unknown[], row: Record<string, unknown> | null) {
    const files = {
      progressFrom: async () => ({ text: '', size: 0, file: null }),
      changes$: NEVER,
      results: async () => results,
    } as unknown as BackupFiles;
    const tryRecord = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      backupRun: {
        findUnique: vi.fn(async () => row),
        findMany: vi.fn(async (query: { where?: { finishedAt?: unknown } }) =>
          // The import asks which runs are finished; the sweep, which are not.
          query.where?.finishedAt === null && row && !row['finishedAt'] ? [{ id: RUN }] : [],
        ),
        upsert: vi.fn(async () => undefined),
        updateMany,
        deleteMany: vi.fn(async () => undefined),
      },
      backupCheck: { findMany: vi.fn(async () => []) },
      backupItem: { findMany: vi.fn(async () => []) },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
    } as unknown as PrismaService;
    const follower = new BackupProgressFollower(files, new ChangesUnderway());
    const results$ = new BackupResults(
      prisma,
      files,
      { tryRecord } as unknown as AuditService,
      follower,
    );
    return { results: results$, tryRecord, updateMany };
  }

  const finished = {
    type: 'run',
    runId: RUN,
    trigger: 'manual',
    itemId: null,
    status: 'failed',
    errorCode: 'busy',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    items: [],
    output: [],
  };

  it('audits a "Back up now" run\'s outcome as the user who started it', async () => {
    const { results, tryRecord } = setUp([finished], {
      finishedAt: null,
      startedById: 'u1',
      startedBy: { username: 'alice' },
    });
    await results.import();
    expect(tryRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'backup.run',
        outcome: 'failure',
        userId: 'u1',
        username: 'alice',
        details: expect.objectContaining({ runId: RUN, trigger: 'manual', reason: 'busy' }),
      }),
    );
  });

  it('records a "Back up now" run that never showed up as failed', async () => {
    const { results, updateMany } = setUp([], {
      finishedAt: null,
      startedAt: new Date(Date.now() - START_GRACE_MS - 1000),
    });
    await results.import();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [RUN] }, finishedAt: null },
        data: expect.objectContaining({ status: 'failed', errorCode: 'interrupted' }),
      }),
    );
  });

  it('leaves a run alone that has a result', async () => {
    const { results, updateMany } = setUp([finished], {
      finishedAt: null,
      startedById: null,
      startedBy: null,
    });
    await results.import();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('BackupResults, runs.jsonl unchanged', () => {
  it('imports the same results only once', async () => {
    const results = [
      {
        type: 'run',
        runId: RUN,
        trigger: 'scheduled',
        itemId: null,
        status: 'ok',
        errorCode: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        items: [],
        output: [],
      },
    ];
    const files = {
      progressFrom: async () => ({ text: '', size: 0, file: null }),
      changes$: NEVER,
      results: async () => results,
    } as unknown as BackupFiles;
    const upsert = vi.fn(async () => undefined);
    const prisma = {
      backupRun: {
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        upsert,
        deleteMany: vi.fn(async () => undefined),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      backupCheck: { findMany: vi.fn(async () => []) },
      backupItem: { findMany: vi.fn(async () => []) },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
    } as unknown as PrismaService;
    const imports = new BackupResults(
      prisma,
      files,
      { tryRecord: vi.fn(async () => undefined) } as unknown as AuditService,
      new BackupProgressFollower(files, new ChangesUnderway()),
    );
    await imports.import();
    await imports.import();
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
