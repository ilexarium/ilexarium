import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BACKUP_ERROR_CODES,
  BACKUP_LIMITS,
  BACKUP_PHASES,
  type BackupPhase,
  type BackupProgress,
  type BackupRestorePhase,
} from '@ilex/shared';
import {
  auditTime,
  exhaustMap,
  interval,
  merge,
  type Observable,
  startWith,
  Subject,
  type Subscription,
} from 'rxjs';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { safely } from '../common/safely.js';
import { watchFolder } from '../common/watch-folder.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProgramConfigService } from '../root-programs/program-config.js';
import {
  type ItemResult,
  JOB_FILE,
  type JobEvent,
  type JobStart,
  jobEventSchema,
  RESTORE_LINES,
  type RunDone,
} from './backup-jobs.constants.js';
import type { Job } from './backup-jobs.model.js';
import { stateDir } from './backup-paths.js';
import {
  BACKUP_FILES_POLL_MS,
  JOB_READ_MS,
  MAX_JOB_FILE_BYTES,
  MAX_RUN_MS,
  RESTORES_KEPT,
  RUNS_KEPT,
  START_GRACE_MS,
} from './backups.constants.js';

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

/** A job from its file's events (`id`: the file's name — its start must name the same job). */
export function readJob(id: string, events: JobEvent[]): Job {
  const job: Job = { id, start: null, progress: null, phase: null, output: [], done: null };
  const first = events[0];
  const ownId =
    first?.type === 'run'
      ? first.runId
      : first?.type === 'check'
        ? first.checkId
        : first?.type === 'restore'
          ? first.restoreId
          : null;
  if (!first || ownId !== id) return job;
  job.start = first as JobStart;
  if (first.type === 'run') {
    job.progress = {
      runId: first.runId,
      trigger: first.trigger,
      startedAt: first.startedAt,
      items: first.items.map((itemId) => ({ itemId, state: 'waiting', phase: null, result: null })),
      output: [],
    };
  }
  const lines = first.type === 'restore' ? RESTORE_LINES : BACKUP_LIMITS.progressLines;
  for (const event of events.slice(1)) {
    const item =
      event.type === 'item' || event.type === 'itemDone'
        ? job.progress?.items.find(
            (i) => i.itemId === (event.type === 'item' ? event.itemId : event.result.itemId),
          )
        : undefined;
    switch (event.type) {
      case 'item':
        if (item && (BACKUP_PHASES as readonly string[]).includes(event.phase)) {
          item.state = 'running';
          item.phase = event.phase as BackupPhase;
        }
        break;
      case 'itemDone':
        if (item) {
          const { archives: _, ...result } = event.result;
          item.state = 'done';
          item.phase = null;
          item.result = result;
        }
        break;
      case 'phase':
        job.phase = event.phase;
        break;
      case 'line':
        job.output.push(event.text);
        if (job.output.length > lines) job.output.shift();
        break;
      case 'runDone':
      case 'checkDone':
      case 'restoreDone':
        if (event.type === `${first.type}Done`) job.done = event;
        break;
    }
  }
  if (job.progress) job.progress.output = job.output;
  return job;
}

/** Whether a process is alive (root's too: that's "permission denied", not "no such process"). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Running: its process is alive — and it started less than a day ago (its pid may be reused). */
const running = (start: JobStart) =>
  processAlive(start.pid) && Date.now() - Date.parse(start.startedAt) < MAX_RUN_MS;

/**
 * The backup program's job files (`<state>/jobs/<id>.jsonl`: a run, a check or a restore) — the
 * only way results and progress reach the app (the program never talks to it, so backups work
 * while it's down). Follows the folder; a running job's file gives its live view; a finished one
 * is saved to the database once. One rule for the rest: a job without an end whose process is
 * gone, or one the app started whose file never appeared, is interrupted. Each run's outcome is
 * audited: scheduled ones as "system", "Back up now" as the user who started it.
 */
@Injectable()
export class BackupJobs implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BackupJobs.name);
  private readonly changed = new Subject<void>();
  private following: Subscription | null = null;
  private refreshing: Promise<void> | null = null;
  private again = false;
  /** Jobs whose result is in the database. */
  private readonly saved = new Set<string>();
  /** Jobs still running, as last read (and which version of the file that was). */
  private readonly live = new Map<string, { version: string; job: Job }>();
  /** Files too large to read (said once). */
  private readonly tooLarge = new Set<string>();

  /** A job moved on, or a result was saved. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  constructor(
    private readonly prisma: PrismaService,
    private readonly programConfigService: ProgramConfigService,
    private readonly auditService: AuditService,
    changesUnderway: ChangesUnderway,
  ) {
    // A run or a restore stops apps on purpose; a repository check doesn't (and may take hours).
    changesUnderway.follow(() =>
      [...this.live.values()].some(({ job }) => job.start?.type !== 'check'),
    );
  }

  get dir(): string {
    return join(stateDir(this.programConfigService.config), 'jobs');
  }

  onApplicationBootstrap(): void {
    // A watch on the folder, and a poll as a fallback (fs.watch can miss some; the folder
    // appears with the first job — until then the poll does the work). A read at a time.
    this.following = merge(
      watchFolder(() => this.dir, BACKUP_FILES_POLL_MS),
      interval(BACKUP_FILES_POLL_MS),
    )
      .pipe(
        startWith(undefined),
        // A running job appends line after line: one read for each short burst.
        auditTime(JOB_READ_MS),
        exhaustMap(() =>
          safely(
            () => this.refresh(),
            (error) => this.logger.error('Could not read the backup jobs', error),
          ),
        ),
      )
      .subscribe();
  }

  onModuleDestroy(): void {
    this.following?.unsubscribe();
  }

  /** The run in progress, or null. */
  runningRun(): BackupProgress | null {
    for (const { job } of this.live.values()) if (job.progress) return job.progress;
    return null;
  }

  /** A running restore's phase and output so far, or null. */
  restoreProgress(id: string): { phase: BackupRestorePhase | null; output: string[] } | null {
    const job = this.live.get(id)?.job;
    return job ? { phase: job.phase, output: job.output } : null;
  }

  /** Reads what's new (one read at a time; a request meanwhile runs once more after it). */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = this.refreshOnce()
      .catch((error: unknown) => this.logger.error('Could not read the backup jobs', error))
      .finally(() => {
        this.refreshing = null;
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    const names = await readdir(this.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const ids = names.filter((name) => JOB_FILE.test(name)).map((name) => name.slice(0, -6));
    const present = new Set(ids);
    // The program deletes old files: their ids needn't be remembered.
    for (const id of this.saved) if (!present.has(id)) this.saved.delete(id);
    for (const id of this.live.keys()) if (!present.has(id)) this.live.delete(id);
    const unknown = ids.filter((id) => !this.saved.has(id) && !this.live.has(id));
    for (const id of await this.savedBefore(unknown)) this.saved.add(id);

    let changed = false;
    for (const id of ids) {
      if (!this.saved.has(id) && (await this.follow(id))) changed = true;
    }
    // A file without a start (or too large to read) counts as never started.
    const started = new Set(ids.filter((id) => this.saved.has(id) || this.live.has(id)));
    if (await this.neverStarted(started)) changed = true;
    if (changed) this.changed.next();
  }

  /** Of these jobs, those whose result is in the database already (after a restart). */
  private async savedBefore(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const where = { id: { in: ids } };
    const found = await Promise.all([
      this.prisma.backupRun.findMany({
        where: { ...where, finishedAt: { not: null } },
        select: { id: true },
      }),
      this.prisma.backupCheck.findMany({ where, select: { id: true } }),
      this.prisma.backupRestore.findMany({
        where: { ...where, status: { not: 'running' } },
        select: { id: true },
      }),
    ]);
    return found.flat().map((row) => row.id);
  }

  /** Reads a job's file if it changed; saves its result once it has one. True: something changed. */
  private async follow(id: string): Promise<boolean> {
    let entry = this.live.get(id);
    const read = await this.read(id, entry?.version);
    if (read === null) return false;
    const changed = read !== 'unchanged';
    if (read !== 'unchanged') entry = read;
    let { job } = entry!;
    // Not started yet (or not a job of the program's): looked at again next time.
    if (!job.start) return false;
    if (!job.done && !running(job.start)) {
      // Its end may have been written between the read and the check: read it once more.
      const last = await this.read(id, undefined);
      if (last !== null && last !== 'unchanged') job = last.job;
    }
    if (job.done || !running(job.start!)) {
      await this.save(job);
      this.saved.add(id);
      this.live.delete(id);
      return true;
    }
    this.live.set(id, entry!);
    return changed;
  }

  /** A job's file, unless it's the version already read; null: gone, or too large to read. */
  private async read(
    id: string,
    known: string | undefined,
  ): Promise<{ version: string; job: Job } | 'unchanged' | null> {
    const file = join(this.dir, `${id}.jsonl`);
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    const version = `${info.ino}:${info.size}:${info.mtimeMs}`;
    if (version === known) return 'unchanged';
    if (info.size > MAX_JOB_FILE_BYTES) {
      if (!this.tooLarge.has(id)) this.logger.error(`${file} is larger than expected; not read`);
      this.tooLarge.add(id);
      return null;
    }
    const { values, skipped } = parseLines(await readFile(file, 'utf8'), jobEventSchema);
    if (skipped > 0) this.logger.warn(`${skipped} lines of ${file} were not understood`);
    return { version, job: readJob(id, values) };
  }

  /** "Back up now" runs and restores the app started that never started: interrupted. */
  private async neverStarted(started: ReadonlySet<string>): Promise<boolean> {
    const before = new Date(Date.now() - START_GRACE_MS);
    const [runs, restores] = await Promise.all([
      this.prisma.backupRun.findMany({
        where: { finishedAt: null, startedAt: { lt: before } },
        select: { id: true },
      }),
      this.prisma.backupRestore.findMany({
        where: { status: 'running', startedAt: { lt: before } },
        select: { id: true },
      }),
    ]);
    const never = (rows: { id: string }[]) =>
      rows.map((row) => row.id).filter((id) => !started.has(id));
    const [lostRuns, lostRestores] = [never(runs), never(restores)];
    if (lostRuns.length === 0 && lostRestores.length === 0) return false;
    const finishedAt = new Date();
    const interrupted = BACKUP_ERROR_CODES.interrupted;
    await this.prisma.backupRun.updateMany({
      where: { id: { in: lostRuns }, finishedAt: null },
      data: { status: 'failed', errorCode: interrupted, finishedAt },
    });
    await this.prisma.backupRestore.updateMany({
      where: { id: { in: lostRestores }, status: 'running' },
      data: { status: 'interrupted', errorCode: interrupted, finishedAt },
    });
    this.logger.warn(`${lostRuns.length + lostRestores.length} backup job(s) never started`);
    return true;
  }

  /** Saves a job's result — or, without one (its process ended first), that it was interrupted. */
  private async save(job: Job): Promise<void> {
    const start = job.start!;
    if (!job.done) this.logger.warn(`Backup job ${job.id} ended without finishing`);
    if (start.type === 'run') {
      await this.saveRun(job.done?.type === 'runDone' ? job.done : interruptedRun(start, job));
    } else if (start.type === 'check') {
      const done = job.done?.type === 'checkDone' ? job.done : null;
      const data = {
        full: start.full,
        status: done?.status ?? 'failed',
        errorCode: done ? done.errorCode : BACKUP_ERROR_CODES.interrupted,
        startedAt: new Date(start.startedAt),
        finishedAt: new Date(done?.finishedAt ?? Date.now()),
      };
      await this.prisma.backupCheck.upsert({
        where: { id: start.checkId },
        create: { id: start.checkId, ...data },
        update: data,
      });
    } else {
      const done = job.done?.type === 'restoreDone' ? job.done : null;
      await this.prisma.backupRestore.updateMany({
        where: { id: start.restoreId, status: 'running' },
        data: {
          status: done?.status ?? 'interrupted',
          phase: job.phase,
          errorCode: done ? done.errorCode : BACKUP_ERROR_CODES.interrupted,
          // Folders set aside are kept even when starting the app afterwards failed: they're the way back.
          setAside: done?.setAside ?? [],
          appWasRunning: done?.appWasRunning ?? false,
          output: job.output.join('\n'),
          finishedAt: new Date(),
        },
      });
      await this.pruneRestores();
    }
  }

  private async saveRun(result: RunDone): Promise<void> {
    const existing = await this.prisma.backupRun.findUnique({
      where: { id: result.runId },
      select: { finishedAt: true, startedById: true, startedBy: { select: { username: true } } },
    });
    const data = {
      trigger: result.trigger,
      itemId: result.itemId,
      status: result.status,
      errorCode: result.errorCode,
      output: result.output.join('\n'),
      startedAt: new Date(result.startedAt),
      finishedAt: new Date(result.finishedAt),
    };
    // The run and its items at once: a reader never sees a finished run with only some items.
    await this.prisma.$transaction(async (tx) => {
      await tx.backupRun.upsert({
        where: { id: result.runId },
        create: { id: result.runId, ...data },
        update: data,
      });
      await saveItemResults(tx, result.runId, result.items, new Date(result.finishedAt));
    });
    await this.pruneRuns();
    // Audited once: a scheduled run when it first arrives; "Back up now" when the run the app
    // started (its row, waiting for this result) ends — as the user who started it.
    const manual = result.trigger === 'manual';
    if (manual ? !existing || existing.finishedAt : existing) return;
    await this.auditService.tryRecord({
      action: 'backup.run',
      outcome: result.status === 'failed' ? 'failure' : 'success',
      ...(manual
        ? { userId: existing!.startedById ?? undefined, username: existing!.startedBy?.username }
        : { username: 'system' }),
      details: {
        runId: result.runId,
        trigger: result.trigger,
        status: result.status,
        ...(result.errorCode ? { reason: result.errorCode } : {}),
      },
    });
  }

  private async pruneRuns(): Promise<void> {
    const old = await this.prisma.backupRun.findMany({
      orderBy: { startedAt: 'desc' },
      skip: RUNS_KEPT,
      select: { id: true },
    });
    if (old.length > 0) {
      await this.prisma.backupRun.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
    }
  }

  /** Old restores go — but never one whose set-aside folders are still there (the list of them). */
  private async pruneRestores(): Promise<void> {
    const old = await this.prisma.backupRestore.findMany({
      orderBy: { startedAt: 'desc' },
      skip: RESTORES_KEPT,
      select: { id: true, setAside: true, setAsideDeletedAt: true },
    });
    const removable = old.filter((r) => r.setAside.length === 0 || r.setAsideDeletedAt !== null);
    if (removable.length > 0) {
      await this.prisma.backupRestore.deleteMany({
        where: { id: { in: removable.map((r) => r.id) } },
      });
    }
  }
}

/** A run whose process ended without a result: failed, with the items it finished. */
function interruptedRun(start: Extract<JobStart, { type: 'run' }>, job: Job): RunDone {
  return {
    type: 'runDone',
    runId: start.runId,
    trigger: start.trigger,
    itemId: start.itemId,
    status: 'failed',
    errorCode: BACKUP_ERROR_CODES.interrupted,
    startedAt: start.startedAt,
    finishedAt: new Date().toISOString(),
    items: (job.progress?.items ?? []).flatMap((item) =>
      item.result ? [{ ...item.result, archives: null }] : [],
    ),
    output: job.output,
  };
}

/** Item results of a run, for items that still exist; their archive lists if newer. */
async function saveItemResults(
  db: Prisma.TransactionClient,
  runId: string,
  items: ItemResult[],
  finishedAt: Date,
): Promise<void> {
  const known = new Set(
    (
      await db.backupItem.findMany({
        where: { id: { in: items.map((i) => i.itemId) } },
        select: { id: true },
      })
    ).map((i) => i.id),
  );
  for (const item of items) {
    if (!known.has(item.itemId)) continue;
    const data = {
      status: item.status,
      errorCode: item.errorCode,
      archive: item.archive,
      originalBytes: item.originalBytes === null ? null : BigInt(Math.round(item.originalBytes)),
      addedBytes: item.addedBytes === null ? null : BigInt(Math.round(item.addedBytes)),
      warnings: item.warnings,
    };
    await db.backupItemResult.upsert({
      where: { runId_itemId: { runId, itemId: item.itemId } },
      create: { runId, itemId: item.itemId, ...data },
      update: data,
    });
    if (item.archives) {
      await db.backupItem.updateMany({
        where: {
          id: item.itemId,
          OR: [{ archivesAt: null }, { archivesAt: { lt: finishedAt } }],
        },
        data: { archives: item.archives, archivesAt: finishedAt },
      });
    }
  }
}
