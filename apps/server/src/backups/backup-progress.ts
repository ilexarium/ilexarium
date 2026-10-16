import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  BACKUP_LIMITS,
  BACKUP_PHASES,
  type BackupPhase,
  type BackupProgress,
} from '@homelab/shared';
import { OperationSlot } from '../jobs/operation-slot.js';
import {
  BackupFiles,
  parseLines,
  progressEventSchema,
  type ProgressEvent,
} from './backup-files.js';
import type { FollowedRun } from './backups.model.js';

/** Longer than the timer's own limit (24 hours): not running, whatever its pid says. */
const MAX_RUN_MS = 25 * 60 * 60_000;

/** Whether a process is alive (root's too: that's "permission denied", not "no such process"). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Applies one progress event to the followed run (a `run` event starts a new one). */
export function applyEvent(run: FollowedRun | null, event: ProgressEvent): FollowedRun | null {
  if (event.type === 'run') {
    return {
      progress: {
        runId: event.runId,
        trigger: event.trigger,
        startedAt: event.startedAt,
        items: event.items.map((itemId) => ({
          itemId,
          state: 'waiting',
          phase: null,
          result: null,
        })),
        output: [],
      },
      itemId: event.itemId,
      pid: event.pid,
      finished: null,
    };
  }
  if (!run) return null;
  const items = run.progress.items;
  switch (event.type) {
    case 'item': {
      const item = items.find((i) => i.itemId === event.itemId);
      if (item) {
        item.state = 'running';
        item.phase = (BACKUP_PHASES as readonly string[]).includes(event.phase)
          ? (event.phase as BackupPhase)
          : item.phase;
      }
      break;
    }
    case 'line':
      run.progress.output.push(event.text);
      if (run.progress.output.length > BACKUP_LIMITS.progressLines) run.progress.output.shift();
      break;
    case 'itemDone': {
      const item = items.find((i) => i.itemId === event.result.itemId);
      if (item) {
        const { archives: _, ...result } = event.result;
        item.state = 'done';
        item.phase = null;
        item.result = result;
      }
      break;
    }
    case 'done':
      if (event.runId === run.progress.runId) {
        run.finished = { status: event.status, errorCode: event.errorCode, at: event.finishedAt };
      }
      break;
  }
  return run;
}

/**
 * Follows the wrapper's live progress file (current.jsonl), scheduled runs and manual ones alike,
 * reading only what's new. A run is running while it has no end **and** its process is alive —
 * one that crashed is reported once as interrupted, never shown running forever. Tells the shared
 * slot while a run goes on, so nothing else starts meanwhile.
 */
@Injectable()
export class BackupProgressFollower implements OnModuleInit {
  private run: FollowedRun | null = null;
  private offset = 0;
  /** Which file `offset` is in (each run writes a new one). */
  private file: string | null = null;
  private reading: Promise<void> | null = null;
  private wasRunning = false;
  private readonly reportedInterrupted = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly interruptedListeners = new Set<(run: FollowedRun) => void>();

  constructor(
    private readonly files: BackupFiles,
    slot: OperationSlot,
  ) {
    slot.followExternal(() => (this.running() ? 'backup' : null));
  }

  onModuleInit(): void {
    this.files.onChange(() => void this.refresh());
    void this.refresh();
  }

  /** The run in progress, or null. */
  running(): BackupProgress | null {
    const run = this.run;
    if (!run || run.finished || !processAlive(run.pid)) return null;
    // Its pid reused by another process long after a crash: systemd stops a run after 24 hours.
    if (Date.now() - Date.parse(run.progress.startedAt) > MAX_RUN_MS) return null;
    return run.progress;
  }

  /** The run the progress file is about (running, finished or crashed), or null. */
  followedRunId(): string | null {
    return this.run?.progress.runId ?? null;
  }

  /** Called when the progress changes. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called once for a run that ended without finishing (its process died). */
  onInterrupted(listener: (run: FollowedRun) => void): () => void {
    this.interruptedListeners.add(listener);
    return () => this.interruptedListeners.delete(listener);
  }

  /** Reads what's new (one read at a time). */
  refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => (this.reading = null));
    return this.reading;
  }

  private async read(): Promise<void> {
    let { text, size, file } = await this.files.progressFrom(this.offset);
    if (file !== this.file || size < this.offset) {
      // A new run wrote a new file: read it from the start.
      this.file = file;
      this.offset = 0;
      ({ text, size } = await this.files.progressFrom(0));
    }
    let changed = false;
    if (text) {
      for (const event of parseLines(text, progressEventSchema).values) {
        this.run = applyEvent(this.run, event);
      }
      this.offset = size;
      changed = true;
    }
    const running = this.running() !== null;
    if (running !== this.wasRunning) changed = true;
    this.wasRunning = running;

    const run = this.run;
    if (run && !run.finished && !running && !this.reportedInterrupted.has(run.progress.runId)) {
      this.reportedInterrupted.add(run.progress.runId);
      for (const listener of this.interruptedListeners) listener(run);
    }
    if (changed) for (const listener of this.listeners) listener();
  }
}
