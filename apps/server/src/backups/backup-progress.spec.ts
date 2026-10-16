import { NEVER } from 'rxjs';
import { OperationSlot } from '../jobs/operation-slot.js';
import type { BackupFiles } from './backup-files.js';
import { BackupProgressFollower } from './backup-progress.js';

const RUN = '55555555-5555-4555-8555-555555555555';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DEAD_PID = 2 ** 22 + 12345; // above the usual pid limit: no such process

/** A progress file in memory: lines appended as the wrapper would. */
function fakeFiles() {
  let text = '';
  let file = 1;
  const files = {
    progressFrom: async (from: number) => ({
      text: text.slice(from),
      size: text.length,
      file: String(file),
    }),
    changes$: NEVER,
  } as unknown as BackupFiles;
  return {
    files,
    write: (event: object) => (text += `${JSON.stringify(event)}\n`),
    /** A new run: a new file. */
    restart: () => {
      text = '';
      file++;
    },
  };
}

const runEvent = (pid = process.pid) => ({
  type: 'run',
  runId: RUN,
  trigger: 'scheduled',
  itemId: null,
  pid,
  startedAt: new Date().toISOString(),
  items: [A, B],
});

describe('BackupProgressFollower', () => {
  it('follows a run: items, phases, output, results — and tells the slot while it runs', async () => {
    const { files, write } = fakeFiles();
    const slot = new OperationSlot();
    const follower = new BackupProgressFollower(files, slot);
    write(runEvent());
    write({ type: 'item', itemId: A, phase: 'archiving' });
    write({ type: 'line', itemId: A, text: 'Creating archive' });
    await follower.refresh();
    expect(follower.running()).toMatchObject({
      runId: RUN,
      trigger: 'scheduled',
      items: [
        { itemId: A, state: 'running', phase: 'archiving', result: null },
        { itemId: B, state: 'waiting', phase: null, result: null },
      ],
      output: ['Creating archive'],
    });
    expect(slot.current()).toBe('backup');

    write({
      type: 'itemDone',
      result: {
        itemId: A,
        status: 'ok',
        errorCode: null,
        archive: 'x',
        originalBytes: 1,
        addedBytes: 1,
        warnings: [],
        archives: ['x'],
      },
    });
    await follower.refresh();
    expect(follower.running()!.items[0]).toMatchObject({ state: 'done', result: { status: 'ok' } });
    expect(follower.running()!.items[0].result).not.toHaveProperty('archives');

    write({
      type: 'done',
      runId: RUN,
      status: 'ok',
      errorCode: null,
      finishedAt: new Date().toISOString(),
    });
    await follower.refresh();
    expect(follower.running()).toBeNull();
    expect(slot.current()).toBeNull();
  });

  it('reports a run whose process died as interrupted, once — never as running', async () => {
    const { files, write } = fakeFiles();
    const follower = new BackupProgressFollower(files, new OperationSlot());
    const interrupted = vi.fn();
    follower.interrupted$.subscribe(interrupted);
    write(runEvent(DEAD_PID));
    await follower.refresh();
    await follower.refresh();
    expect(follower.running()).toBeNull();
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(interrupted.mock.calls[0][0].progress.runId).toBe(RUN);
  });

  it('starts over when a new run starts the file afresh, and skips lines it doesn’t understand', async () => {
    const { files, write, restart } = fakeFiles();
    const follower = new BackupProgressFollower(files, new OperationSlot());
    write(runEvent());
    write({ type: 'line', itemId: A, text: 'x'.repeat(100) });
    await follower.refresh();
    restart();
    // Already longer than what was read of the old file: told apart by the file itself.
    write({ ...runEvent(), runId: B });
    write({ type: 'unknown' });
    write({ type: 'line', itemId: A, text: 'y'.repeat(200) });
    await follower.refresh();
    expect(follower.running()).toMatchObject({ runId: B, output: ['y'.repeat(200)] });
  });
});
