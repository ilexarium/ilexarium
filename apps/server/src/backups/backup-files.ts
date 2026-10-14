import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { type FSWatcher, watch } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import { stateDir } from './backup-paths.js';

/** How often the files are looked at when no change notice arrives (fs.watch can miss some). */
export const BACKUP_FILES_POLL_MS = 5_000;
const MAX_RESULTS_BYTES = 16 * 1024 * 1024;

// What the backup wrapper writes (system/wrappers/homelab-backup.mts) — root-owned, still checked.

const status = z.enum(['ok', 'warning', 'failed']);
const itemResultSchema = z.object({
  itemId: z.uuid(),
  status,
  errorCode: z.string().max(64).nullable(),
  archive: z.string().max(128).nullable(),
  originalBytes: z.number().nonnegative().nullable(),
  addedBytes: z.number().nonnegative().nullable(),
  warnings: z.array(z.string().max(1000)).max(50),
  archives: z.array(z.string().max(128)).max(10_000).nullable().optional(),
});
export type WrapperItemResult = z.infer<typeof itemResultSchema>;

const runResultSchema = z.object({
  type: z.literal('run'),
  runId: z.uuid(),
  trigger: z.enum(['scheduled', 'manual']),
  itemId: z.uuid().nullable(),
  status,
  errorCode: z.string().max(64).nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  items: z.array(itemResultSchema).max(200),
  output: z.array(z.string().max(4000)).max(500),
});
export type WrapperRunResult = z.infer<typeof runResultSchema>;

const checkResultSchema = z.object({
  type: z.literal('check'),
  checkId: z.uuid(),
  full: z.boolean(),
  status,
  errorCode: z.string().max(64).nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});
export type WrapperCheckResult = z.infer<typeof checkResultSchema>;

const resultSchema = z.discriminatedUnion('type', [runResultSchema, checkResultSchema]);
export type WrapperResult = z.infer<typeof resultSchema>;

/** One line of current.jsonl: the live progress of a run. */
export const progressEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run'),
    runId: z.uuid(),
    trigger: z.enum(['scheduled', 'manual']),
    itemId: z.uuid().nullable(),
    pid: z.number().int().positive(),
    startedAt: z.iso.datetime(),
    items: z.array(z.uuid()).max(200),
  }),
  z.object({ type: z.literal('item'), itemId: z.uuid(), phase: z.string().max(32) }),
  z.object({ type: z.literal('line'), itemId: z.uuid(), text: z.string().max(4000) }),
  z.object({ type: z.literal('itemDone'), result: itemResultSchema }),
  z.object({
    type: z.literal('done'),
    runId: z.uuid(),
    status,
    errorCode: z.string().max(64).nullable(),
    finishedAt: z.iso.datetime(),
  }),
]);
export type ProgressEvent = z.infer<typeof progressEventSchema>;

/** Parses JSON lines with a schema; lines that don't fit are skipped (and counted). */
export function parseLines<T>(
  text: string,
  schema: z.ZodType<T>,
): { values: T[]; skipped: number } {
  const values: T[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) values.push(parsed.data);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { values, skipped };
}

/**
 * The backup wrapper's files the app reads — the only way results and progress reach it (the
 * wrapper never talks to the app, so backups work while it's down): `runs.jsonl` (each finished
 * run and check) and `current.jsonl` (the running run, event by event). Watched, with a poll as a
 * fallback.
 */
@Injectable()
export class BackupFiles implements OnModuleDestroy {
  private readonly logger = new Logger(BackupFiles.name);
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly wrapperConfig: WrapperConfigService) {}

  get dir(): string {
    return stateDir(this.wrapperConfig.config);
  }

  /** Every result in runs.jsonl, oldest first (missing file: none). */
  async results(): Promise<WrapperResult[]> {
    const file = join(this.dir, 'runs.jsonl');
    try {
      if ((await stat(file)).size > MAX_RESULTS_BYTES) {
        this.logger.error(`${file} is larger than expected; not read`);
        return [];
      }
      const { values, skipped } = parseLines(await readFile(file, 'utf8'), resultSchema);
      if (skipped > 0) this.logger.warn(`${skipped} lines of ${file} were not understood`);
      return values;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.error(`Could not read ${file}: ${(error as Error).message}`);
      }
      return [];
    }
  }

  /**
   * current.jsonl from byte `from`: the new text, the position after it, and which file it is
   * (each run writes a new one) — empty when it's missing.
   */
  async progressFrom(from: number): Promise<{ text: string; size: number; file: string | null }> {
    const path = join(this.dir, 'current.jsonl');
    try {
      const handle = await open(path, 'r');
      try {
        const { size, dev, ino } = await handle.stat();
        const file = `${dev}:${ino}`;
        if (size <= from) return { text: '', size, file };
        const length = Math.min(size - from, 2 * 1024 * 1024);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, from);
        // Only whole lines: the rest is read next time.
        const text = buffer.toString('utf8');
        const end = text.lastIndexOf('\n') + 1;
        return {
          text: text.slice(0, end),
          size: from + Buffer.byteLength(text.slice(0, end)),
          file,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.error(`Could not read ${path}: ${(error as Error).message}`);
      }
      return { text: '', size: 0, file: null };
    }
  }

  /** Called when the files may have changed. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    this.startWatching();
    return () => this.listeners.delete(listener);
  }

  onModuleDestroy(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private startWatching(): void {
    this.timer ??= setInterval(() => {
      this.tryWatch();
      this.notify();
    }, BACKUP_FILES_POLL_MS);
    this.timer.unref();
    this.tryWatch();
  }

  /** The folder appears with the first run: until then the poll does the work. */
  private tryWatch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.dir, { persistent: false }, () => this.notify());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
