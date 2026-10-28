import { Injectable, Logger } from '@nestjs/common';
import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { interval, map, merge, type Observable, share } from 'rxjs';
import { backupRestorePhaseSchema } from '@laris/shared';
import { z } from 'zod';
import { watchFolder } from '../common/watch-folder.js';
import { ProgramConfigService } from '../root-programs/program-config.js';
import { stateDir } from './backup-paths.js';
import {
  BACKUP_FILES_POLL_MS,
  MAX_PROGRESS_READ_BYTES,
  MAX_RESULTS_BYTES,
} from './backups.constants.js';

// What the backup wrapper writes (system/programs/laris-backup.mts) — root-owned, still checked.

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

/** One line of a restore's events file. */
export const restoreEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), pid: z.number().int().positive() }),
  z.object({ type: z.literal('phase'), phase: backupRestorePhaseSchema }),
  z.object({ type: z.literal('line'), text: z.string().max(4000) }),
  z.object({
    type: z.literal('done'),
    status: z.enum(['succeeded', 'failed']),
    errorCode: z.string().max(60).nullable(),
    setAside: z.array(z.string().max(4096)).max(100),
  }),
]);
export type RestoreEvent = z.infer<typeof restoreEventSchema>;
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
 * run and check) and `current.jsonl` (the running run, event by event).
 */
@Injectable()
export class BackupFiles {
  private readonly logger = new Logger(BackupFiles.name);
  /** runs.jsonl as last read, and which version of the file that was. */
  private lastResults: { version: string; results: WrapperResult[] } | null = null;

  /**
   * The files may have changed: a watch on their folder, and a poll as a fallback (fs.watch can
   * miss some; the folder appears with the first run — until then the poll does the work).
   * Watching starts with the first subscriber and stops after the last.
   */
  readonly changes$: Observable<void>;

  constructor(private readonly programConfigService: ProgramConfigService) {
    this.changes$ = merge(
      watchFolder(() => this.dir, BACKUP_FILES_POLL_MS),
      interval(BACKUP_FILES_POLL_MS),
    ).pipe(
      map(() => undefined),
      share(),
    );
  }

  get dir(): string {
    return stateDir(this.programConfigService.config);
  }

  /**
   * Every result in runs.jsonl, oldest first (missing file: none). The same array as last time
   * while the file hasn't changed — the poll asks every few seconds, the file rarely changes.
   */
  async results(): Promise<WrapperResult[]> {
    const file = join(this.dir, 'runs.jsonl');
    try {
      const { size, mtimeMs, ino } = await stat(file);
      if (size > MAX_RESULTS_BYTES) {
        this.logger.error(`${file} is larger than expected; not read`);
        return [];
      }
      const version = `${ino}:${size}:${mtimeMs}`;
      if (this.lastResults?.version === version) return this.lastResults.results;
      const { values, skipped } = parseLines(await readFile(file, 'utf8'), resultSchema);
      if (skipped > 0) this.logger.warn(`${skipped} lines of ${file} were not understood`);
      this.lastResults = { version, results: values };
      return values;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.error(`Could not read ${file}: ${(error as Error).message}`);
      }
      return [];
    }
  }

  /**
   * A restore's events (`restores/<id>.jsonl`, written by its unit): its phases, output lines and
   * end; null when the file isn't there (yet).
   */
  async restoreEvents(restoreId: string): Promise<RestoreEvent[] | null> {
    const file = join(this.dir, 'restores', `${restoreId}.jsonl`);
    try {
      const { size } = await stat(file);
      if (size > MAX_PROGRESS_READ_BYTES) {
        const handle = await open(file, 'r');
        try {
          const buffer = Buffer.alloc(MAX_PROGRESS_READ_BYTES);
          await handle.read(buffer, 0, buffer.length, size - buffer.length);
          const text = buffer.toString('utf8');
          return parseLines(text.slice(text.indexOf('\n') + 1), restoreEventSchema).values;
        } finally {
          await handle.close();
        }
      }
      return parseLines(await readFile(file, 'utf8'), restoreEventSchema).values;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.error(`Could not read ${file}: ${(error as Error).message}`);
      }
      return null;
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
        const length = Math.min(size - from, MAX_PROGRESS_READ_BYTES);
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
}
