import type { BackupsStatus } from '@laris/shared';
import { Subject } from 'rxjs';
import { OperationSlot } from '../jobs/operation-slot.js';
import type { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { BackupPlanManager } from './backup-plan-manager.js';
import type { BackupProgressFollower } from './backup-progress.js';
import type { BackupRestores } from './backup-restores.js';
import type { BackupResults } from './backup-results.js';
import type { BackupRuns } from './backup-runs.js';
import type { BackupStatusReader } from './backup-status-reader.js';
import { BACKUPS_PUBLISH_MS, BackupsTopic } from './backups-topic.js';

const STATUS = { configured: true } as BackupsStatus;

function setUp() {
  const changes = {
    plans: new Subject<void>(),
    runs: new Subject<void>(),
    progress: new Subject<void>(),
    results: new Subject<void>(),
    restores: new Subject<void>(),
  };
  const status = vi.fn(async () => STATUS);
  const slot = new OperationSlot();
  const topic = new BackupsTopic(
    { status } as unknown as BackupStatusReader,
    { changes$: changes.plans } as unknown as BackupPlanManager,
    { changes$: changes.runs } as unknown as BackupRuns,
    { changes$: changes.progress } as unknown as BackupProgressFollower,
    { changes$: changes.results } as unknown as BackupResults,
    { changes$: changes.restores } as unknown as BackupRestores,
    slot,
    { registerSource: () => undefined } as unknown as RealtimeSubscriptions,
  );
  const publish = vi.fn();
  const subscription = topic.updates$.subscribe(publish);
  return { changes, status, slot, publish, stop: () => subscription.unsubscribe() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('BackupsTopic', () => {
  it('publishes one snapshot for a burst of changes, from any source', async () => {
    const { stop, changes, slot, publish } = setUp();
    changes.progress.next();
    changes.progress.next();
    changes.results.next();
    slot.claim('backup');
    await vi.advanceTimersByTimeAsync(BACKUPS_PUBLISH_MS - 1);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(STATUS);
    stop();
  });

  it('goes on after a snapshot failed: the next change publishes', async () => {
    const { stop, changes, status, publish } = setUp();
    status.mockRejectedValueOnce(new Error('database away'));
    changes.plans.next();
    await vi.advanceTimersByTimeAsync(BACKUPS_PUBLISH_MS);
    expect(publish).not.toHaveBeenCalled();
    changes.plans.next();
    await vi.advanceTimersByTimeAsync(BACKUPS_PUBLISH_MS);
    expect(publish).toHaveBeenCalledTimes(1);
    stop();
  });

  it('publishes now and then without a change ("last backed up" ages)', async () => {
    const { stop, publish } = setUp();
    await vi.advanceTimersByTimeAsync(60_000 + BACKUPS_PUBLISH_MS);
    expect(publish).toHaveBeenCalledTimes(1);
    stop();
  });

  it('leaves nothing behind when stopped: no timers, no more publishing', async () => {
    const { stop, changes, slot, publish } = setUp();
    changes.runs.next();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    changes.runs.next();
    slot.claim('backup');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publish).not.toHaveBeenCalled();
  });
});
