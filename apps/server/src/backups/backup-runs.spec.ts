import { Subject } from 'rxjs';
import type { ExecutorService } from '../executor/executor.service.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { BackupProgressFollower } from './backup-progress.js';
import type { BackupResults } from './backup-results.js';
import { BackupRuns } from './backup-runs.js';
import { HANDOVER_MS } from './backups.constants.js';

const actor = { user: { id: 'u1', username: 'alice' }, ip: '127.0.0.1' } as never;

function setUp() {
  const progressChanges = new Subject<void>();
  const resultChanges = new Subject<void>();
  let followed: string | null = null;
  let finishedAt: Date | null = null;
  const follower = {
    changes$: progressChanges.asObservable(),
    followedRunId: () => followed,
  } as unknown as BackupProgressFollower;
  const results = { changes$: resultChanges.asObservable() } as unknown as BackupResults;
  const prisma = {
    backupPlan: { findUnique: vi.fn(async () => ({ id: 1 })) },
    backupRun: {
      create: vi.fn(async () => undefined),
      findUnique: vi.fn(async () => ({ finishedAt })),
    },
  } as unknown as PrismaService;
  const executor = {
    backupStart: vi.fn(async () => ({ ok: true, result: { started: true } })),
  } as unknown as ExecutorService;
  const slot = new OperationSlot();
  const runs = new BackupRuns(prisma, executor, slot, follower, results);
  return {
    runs,
    slot,
    showRun: (id: string) => {
      followed = id;
      progressChanges.next();
    },
    finish: () => {
      finishedAt = new Date();
      resultChanges.next();
    },
  };
}

describe('BackupRuns.runNow', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the slot until the run shows in the progress file', async () => {
    const { runs, slot, showRun } = setUp();
    const { runId } = await runs.runNow({}, actor);
    expect(slot.current()).toBe('backup');
    await vi.waitFor(() => expect(slot.current()).toBe('backup'));
    showRun(runId);
    await vi.waitFor(() => expect(slot.current()).toBeNull());
  });

  it('frees the slot when the run already has its result (refused at once)', async () => {
    const { runs, slot, finish } = setUp();
    await runs.runNow({}, actor);
    finish();
    await vi.waitFor(() => expect(slot.current()).toBeNull());
  });

  it('frees the slot after a while when the run never shows', async () => {
    vi.useFakeTimers();
    const { runs, slot } = setUp();
    await runs.runNow({}, actor);
    await vi.advanceTimersByTimeAsync(HANDOVER_MS - 1);
    expect(slot.current()).toBe('backup');
    await vi.advanceTimersByTimeAsync(1);
    expect(slot.current()).toBeNull();
  });
});
