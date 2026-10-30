import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditService } from '../audit/audit.service.js';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ProgramConfigService } from '../root-programs/program-config.js';
import { BackupJobs, readJob } from './backup-jobs.js';
import { START_GRACE_MS } from './backups.constants.js';

const RUN = '55555555-5555-4555-8555-555555555555';
const RESTORE = '66666666-6666-4666-8666-666666666666';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DEAD_PID = 2 ** 22 + 12345; // above the usual pid limit: no such process

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-jobs-'));
  mkdirSync(join(dir, 'state', 'jobs'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Appends events to a job's file, as the program would. */
const write = (id: string, ...events: object[]) =>
  appendFileSync(
    join(dir, 'state', 'jobs', `${id}.jsonl`),
    events.map((event) => `${JSON.stringify(event)}\n`).join(''),
  );

const runStart = (pid = process.pid, trigger = 'scheduled') => ({
  type: 'run',
  runId: RUN,
  trigger,
  itemId: null,
  pid,
  startedAt: new Date().toISOString(),
  items: [A, B],
});

const itemResult = (itemId: string) => ({
  itemId,
  status: 'ok',
  errorCode: null,
  archive: 'x',
  originalBytes: 1,
  addedBytes: 1,
  warnings: [],
  archives: ['x'],
});

const runDone = (trigger = 'scheduled') => ({
  type: 'runDone',
  runId: RUN,
  trigger,
  itemId: null,
  status: 'ok',
  errorCode: null,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  items: [itemResult(A)],
  output: ['done'],
});

/** The database as far as the jobs touch it: `runRow` is the run's row, if there is one. */
function setUp(runRow: Record<string, unknown> | null = null) {
  const prisma = {
    backupRun: {
      findUnique: vi.fn(async () => runRow),
      findMany: vi.fn(async (query: { where?: { finishedAt?: unknown } }) =>
        // Which runs are saved already; which the app started and haven't finished; old ones.
        query.where?.finishedAt === null && runRow && !runRow['finishedAt'] ? [{ id: RUN }] : [],
      ),
      upsert: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => undefined),
    },
    backupCheck: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => undefined) },
    backupRestore: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => undefined),
    },
    backupItem: {
      findMany: vi.fn(async () => [{ id: A }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    backupItemResult: { upsert: vi.fn(async () => undefined) },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  };
  const tryRecord = vi.fn(async () => undefined);
  const slot = new ChangesUnderway();
  const jobs = new BackupJobs(
    prisma as unknown as PrismaService,
    { config: { backup: { dev: { dir } } } } as unknown as ProgramConfigService,
    { tryRecord } as unknown as AuditService,
    slot,
  );
  const changes = vi.fn();
  jobs.changes$.subscribe(changes);
  return { jobs, prisma, tryRecord, slot, changes };
}

describe('BackupJobs', () => {
  it('follows a run while it runs, then saves its result once', async () => {
    const { jobs, prisma, slot, tryRecord, changes } = setUp();
    write(RUN, runStart());
    write(RUN, { type: 'item', itemId: A, phase: 'archiving' });
    write(RUN, { type: 'line', itemId: A, text: 'Creating archive' });
    await jobs.refresh();
    expect(jobs.runningRun()).toMatchObject({
      runId: RUN,
      trigger: 'scheduled',
      items: [
        { itemId: A, state: 'running', phase: 'archiving', result: null },
        { itemId: B, state: 'waiting', phase: null, result: null },
      ],
      output: ['Creating archive'],
    });
    expect(slot.anything()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);

    write(RUN, { type: 'itemDone', result: itemResult(A) });
    await jobs.refresh();
    expect(jobs.runningRun()!.items[0]).toMatchObject({ state: 'done', result: { status: 'ok' } });
    expect(jobs.runningRun()!.items[0].result).not.toHaveProperty('archives');

    write(RUN, runDone());
    await jobs.refresh();
    await jobs.refresh();
    expect(jobs.runningRun()).toBeNull();
    expect(slot.anything()).toBe(false);
    expect(prisma.backupRun.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.backupRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: RUN },
        create: expect.objectContaining({ status: 'ok', output: 'done' }),
      }),
    );
    expect(prisma.backupItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ archives: ['x'] }) }),
    );
    expect(tryRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'backup.run', username: 'system' }),
    );
  });

  it('saves a run whose process died as interrupted — never shown as running', async () => {
    const { jobs, prisma } = setUp();
    write(RUN, runStart(DEAD_PID), { type: 'itemDone', result: itemResult(A) });
    await jobs.refresh();
    await jobs.refresh();
    expect(jobs.runningRun()).toBeNull();
    expect(prisma.backupRun.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.backupRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'failed', errorCode: 'interrupted' }),
      }),
    );
    // The item it finished keeps its result.
    expect(prisma.backupItemResult.upsert).toHaveBeenCalledTimes(1);
  });

  it('audits a "Back up now" run’s outcome as the user who started it', async () => {
    const { jobs, tryRecord } = setUp({
      finishedAt: null,
      startedAt: new Date(),
      startedById: 'u1',
      startedBy: { username: 'alice' },
    });
    write(RUN, runStart(process.pid, 'manual'), {
      ...runDone('manual'),
      status: 'failed',
      errorCode: 'busy',
    });
    await jobs.refresh();
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

  it('marks a "Back up now" run whose file never appeared as interrupted', async () => {
    const { jobs, prisma } = setUp({
      finishedAt: null,
      startedAt: new Date(Date.now() - START_GRACE_MS - 1000),
    });
    await jobs.refresh();
    expect(prisma.backupRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [RUN] }, finishedAt: null },
        data: expect.objectContaining({ status: 'failed', errorCode: 'interrupted' }),
      }),
    );
  });

  it('leaves a job alone whose result the database has (after a restart)', async () => {
    const { jobs, prisma } = setUp();
    prisma.backupRun.findMany.mockResolvedValueOnce([{ id: RUN }]);
    write(RUN, runStart(), runDone());
    await jobs.refresh();
    expect(prisma.backupRun.upsert).not.toHaveBeenCalled();
  });

  it('shows a restore’s phase and output while it runs, then saves its result and the folders set aside', async () => {
    const { jobs, prisma } = setUp();
    const start = { type: 'restore', restoreId: RESTORE, pid: process.pid };
    write(RESTORE, { ...start, startedAt: new Date().toISOString() });
    write(RESTORE, { type: 'phase', phase: 'restoring' }, { type: 'line', text: 'x' });
    await jobs.refresh();
    expect(jobs.restoreProgress(RESTORE)).toEqual({ phase: 'restoring', output: ['x'] });
    write(RESTORE, {
      type: 'restoreDone',
      status: 'succeeded',
      errorCode: null,
      setAside: ['/srv/docs.before-restore-20261030-120000'],
    });
    await jobs.refresh();
    expect(jobs.restoreProgress(RESTORE)).toBeNull();
    expect(prisma.backupRestore.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: RESTORE, status: 'running' },
        data: expect.objectContaining({
          status: 'succeeded',
          phase: 'restoring',
          setAside: ['/srv/docs.before-restore-20261030-120000'],
          output: 'x',
        }),
      }),
    );
  });
});

describe('readJob', () => {
  it('ignores a file whose first event names another job', () => {
    expect(readJob(B, [runStart() as never]).start).toBeNull();
  });

  it('takes only its own kind of end', () => {
    const job = readJob(RUN, [runStart(), { type: 'checkDone' }] as never);
    expect(job.done).toBeNull();
  });
});
