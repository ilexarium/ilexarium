import type { FSWatcher } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subscription } from 'rxjs';
import type { WrapperConfigService } from '../executor/wrapper-config.js';
import { BACKUP_FILES_POLL_MS, BackupFiles } from './backup-files.js';

/** Every watcher made, to see that it's closed. */
const watchers = vi.hoisted(() => [] as FSWatcher[]);
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    watch: (...args: Parameters<typeof fs.watch>) => {
      const watcher = fs.watch(...args);
      watchers.push(watcher);
      return watcher;
    },
  };
});

/** Real time, for the file system's own notices (the timers are fake). */
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));

let dir: string;
let subscription: Subscription | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-files-'));
  watchers.length = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  subscription?.unsubscribe();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function filesIn(root: string) {
  const config = { config: { backup: { dev: { dir: root } } } } as WrapperConfigService;
  return new BackupFiles(config);
}

describe('BackupFiles.changes$', () => {
  it('polls while the folder is missing, and watches it once it appears', async () => {
    const files = filesIn(dir);
    const notices = vi.fn();
    subscription = files.changes$.subscribe(notices);

    await vi.advanceTimersByTimeAsync(BACKUP_FILES_POLL_MS);
    expect(notices).toHaveBeenCalledTimes(1); // the poll; the watch failed (no folder yet)
    expect(watchers).toHaveLength(0);

    mkdirSync(join(dir, 'state'));
    await vi.advanceTimersByTimeAsync(BACKUP_FILES_POLL_MS); // the watch is tried again
    expect(watchers).toHaveLength(1);
    const polled = notices.mock.calls.length;

    writeFileSync(join(dir, 'state', 'current.jsonl'), '{}\n');
    for (let i = 0; i < 100 && notices.mock.calls.length === polled; i++) await sleep(10);
    expect(notices.mock.calls.length).toBeGreaterThan(polled); // at once, not at the next poll
  });

  it('shares one watch and stops it — watcher and timers — after the last subscriber', async () => {
    mkdirSync(join(dir, 'state'));
    const files = filesIn(dir);
    const first = files.changes$.subscribe();
    const second = files.changes$.subscribe();
    expect(watchers).toHaveLength(1);
    const close = vi.spyOn(watchers[0], 'close');

    first.unsubscribe();
    expect(close).not.toHaveBeenCalled();
    second.unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
