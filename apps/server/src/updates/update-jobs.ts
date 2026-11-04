import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  UPDATE_OUTCOMES,
  UPDATE_PHASES,
  type UpdateJob,
  type UpdateOutcome,
  type UpdatePhase,
} from '@laris/shared';
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
import { AuditService } from '../audit/audit.service.js';
import { safely } from '../common/safely.js';
import { watchFolder } from '../common/watch-folder.js';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpdatePlaces } from './update-places.js';
import {
  JOB_READ_MS,
  JOB_STALE_MS,
  OUTPUT_LINES_KEPT,
  UPDATE_FILES_POLL_MS,
} from './updates.constants.js';

const JOB_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** One job file's events as a job; null if it has no start (being written, or not ours). */
export function readJob(
  id: string,
  text: string,
  modifiedAt: number,
  now = Date.now(),
): UpdateJob | null {
  let job: UpdateJob | null = null;
  for (const line of text.split('\n')) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      event['type'] === 'start' &&
      typeof event['from'] === 'string' &&
      typeof event['to'] === 'string'
    ) {
      job = {
        id,
        from: event['from'],
        to: event['to'],
        startedAt:
          typeof event['at'] === 'string' ? event['at'] : new Date(modifiedAt).toISOString(),
        phase: null,
        download: null,
        output: [],
        done: null,
      };
      continue;
    }
    if (!job) continue;
    switch (event['type']) {
      case 'phase':
        if ((UPDATE_PHASES as readonly unknown[]).includes(event['phase'])) {
          job.phase = event['phase'] as UpdatePhase;
          if (job.phase === 'download' && typeof event['total'] === 'number') {
            job.download = { bytes: 0, total: event['total'] };
          }
        }
        break;
      case 'progress':
        if (typeof event['bytes'] === 'number' && typeof event['total'] === 'number') {
          job.download = { bytes: event['bytes'], total: event['total'] };
        }
        break;
      case 'line':
        if (typeof event['text'] === 'string') {
          job.output = [...job.output, event['text'].slice(0, 1000)].slice(-OUTPUT_LINES_KEPT);
        }
        break;
      case 'done':
        if (
          (UPDATE_OUTCOMES as readonly unknown[]).includes(event['outcome']) &&
          typeof event['version'] === 'string'
        ) {
          job.done = {
            outcome: event['outcome'] as UpdateOutcome,
            version: event['version'],
            error: typeof event['error'] === 'string' ? event['error'] : null,
          };
        }
        break;
    }
  }
  // Past the unit's own time limit without an end: the machine went down meanwhile.
  if (job && !job.done && now - modifiedAt > JOB_STALE_MS) {
    job.done = { outcome: 'failed', version: job.from, error: 'interrupted' };
  }
  return job;
}

/**
 * laris-update's job files (/var/lib/laris/updates/<id>.jsonl, readable by the app's group): the
 * running update or the last one's result. An update's end is written while the app restarts —
 * it's recorded (the run's row and the audit log) whenever it's first read, also after the restart.
 */
@Injectable()
export class UpdateJobs implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UpdateJobs.name);
  private readonly changed = new Subject<void>();
  readonly changes$: Observable<void> = this.changed.asObservable();
  private following: Subscription | null = null;
  private current: UpdateJob | null = null;
  private seen = '';

  constructor(
    private readonly updatePlaces: UpdatePlaces,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    changesUnderway: ChangesUnderway,
  ) {
    // The installer stops the app and the platform's containers on purpose.
    changesUnderway.follow(() => this.running());
  }

  onApplicationBootstrap(): void {
    this.following = merge(
      watchFolder(() => this.updatePlaces.jobsDir, UPDATE_FILES_POLL_MS),
      interval(UPDATE_FILES_POLL_MS),
    )
      .pipe(
        startWith(undefined),
        auditTime(JOB_READ_MS),
        exhaustMap(() =>
          safely(
            () => this.refresh(),
            (error) => this.logger.error('Could not read the update jobs', error),
          ),
        ),
      )
      .subscribe();
  }

  onModuleDestroy(): void {
    this.following?.unsubscribe();
  }

  /** The newest update: running, or the last one's result. */
  latest(): UpdateJob | null {
    return this.current;
  }

  running(): boolean {
    return this.current !== null && this.current.done === null;
  }

  async refresh(): Promise<void> {
    const dir = this.updatePlaces.jobsDir;
    const names = await readdir(dir).catch(() => [] as string[]);
    let newest: { id: string; path: string; at: number } | null = null;
    for (const name of names) {
      const id = JOB_FILE.exec(name)?.[1];
      if (!id) continue;
      const at = (await stat(join(dir, name)).catch(() => null))?.mtimeMs;
      if (at !== undefined && (!newest || at > newest.at))
        newest = { id, path: join(dir, name), at };
    }
    const job = newest ? readJob(newest.id, await readFile(newest.path, 'utf8'), newest.at) : null;
    const key = JSON.stringify(job);
    if (key === this.seen) return;
    this.seen = key;
    this.current = job;
    if (job?.done) await this.record(job);
    this.changed.next();
  }

  /** The end of an update this app started, once: its row, then the audit log. */
  private async record(job: UpdateJob): Promise<void> {
    const done = job.done!;
    const { count } = await this.prisma.updateRun.updateMany({
      where: { id: job.id, finishedAt: null },
      data: { finishedAt: new Date(), outcome: done.outcome, error: done.error },
    });
    if (count === 0) return;
    const run = await this.prisma.updateRun.findUnique({ where: { id: job.id } });
    if (!run) return;
    await this.auditService.tryRecord({
      action: 'laris.update_result',
      userId: run.userId,
      username: run.username,
      ip: run.ip ?? undefined,
      outcome: done.outcome === 'updated' ? 'success' : 'failure',
      details: {
        from: job.from,
        to: job.to,
        result: done.outcome,
        ...(done.error && { reason: done.error }),
      },
    });
  }
}
