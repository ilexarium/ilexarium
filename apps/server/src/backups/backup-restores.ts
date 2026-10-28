import {
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  BACKUP_ERROR_CODES,
  BACKUP_LIMITS,
  type BackupRestore,
  type BackupRestorePhase,
  type BackupRestoreRequest,
} from '@laris/shared';
import { Observable, Subject } from 'rxjs';
import type { BackupRestore as BackupRestoreRow } from '../generated/prisma/client.js';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RootActor } from '../root-programs/root-programs.model.js';
import { RootPrograms } from '../root-programs/root-programs.js';
import { BackupChecks } from './backup-checks.js';
import { apiError, backupError } from './backup-errors.js';
import { BackupFiles, type RestoreEvent } from './backup-files.js';
import { processAlive } from './backup-progress.js';
import { requireItem, requirePlan } from './backup-records.js';
import {
  MAX_RUN_MS,
  RESTORE_POLL_MS,
  RESTORE_START_GRACE_MS,
  RESTORES_KEPT,
  RESTORES_SHOWN,
} from './backups.constants.js';

/** What a running restore's events file said so far. */
interface Following {
  phase: BackupRestorePhase | null;
  output: string[];
}

/**
 * Restores: started through the person's sudo, run by systemd as their own unit
 * (`laris-restore@<id>`) — they go on if the app stops. Their phases, output and result come back
 * through the program's events file (`restores/<id>.jsonl`), read while they run; the result is
 * saved (the folders set aside: the way back). The history, and "Delete previous version".
 */
@Injectable()
export class BackupRestores implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BackupRestores.name);
  private readonly following = new Map<string, Following>();
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private readonly changed = new Subject<void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rootPrograms: RootPrograms,
    private readonly backupChecks: BackupChecks,
    private readonly backupFiles: BackupFiles,
    changesUnderway: ChangesUnderway,
  ) {
    changesUnderway.follow(() => this.following.size > 0);
  }

  /** Restores that ran while the app was down are followed again (or finished from their file). */
  async onApplicationBootstrap(): Promise<void> {
    const running = await this.prisma.backupRestore.findMany({
      where: { status: 'running' },
      select: { id: true },
    });
    for (const { id } of running) this.follow(id);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A restore started, moved on or ended; a set-aside folder was deleted. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  async restore(request: BackupRestoreRequest, actor: RootActor): Promise<{ restoreId: string }> {
    const plan = await requirePlan(this.prisma);
    const item = await requireItem(this.prisma, request.itemId);
    if (!item.archives.includes(request.archive)) {
      throw new NotFoundException(apiError('No such backup', BACKUP_ERROR_CODES.archiveNotFound));
    }
    if (request.target !== null) this.backupChecks.checkRestoreTarget(request.target, plan.destination);
    const row = await this.prisma.backupRestore.create({
      data: {
        itemId: item.id,
        archive: request.archive,
        targetPath: request.target,
        status: 'running',
        startedById: actor.user.id,
      },
    });
    try {
      const outcome = await this.rootPrograms.backupRestoreStart(
        { restoreId: row.id, itemId: item.id, archive: request.archive, target: request.target },
        actor,
      );
      if (!outcome.ok) throw backupError(outcome.code);
    } catch (failure) {
      await this.prisma.backupRestore.delete({ where: { id: row.id } });
      throw failure;
    }
    this.follow(row.id);
    this.notify();
    return { restoreId: row.id };
  }

  async restores(): Promise<BackupRestore[]> {
    const rows = await this.prisma.backupRestore.findMany({
      orderBy: { startedAt: 'desc' },
      take: RESTORES_SHOWN,
    });
    return rows.map((row) => this.view(row));
  }

  async restoreJob(id: string): Promise<BackupRestore> {
    const row = await this.prisma.backupRestore.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(apiError('No such restore', BACKUP_ERROR_CODES.restoreNotFound));
    }
    return this.view(row);
  }

  /** "Delete previous version": the folders a restore set aside. */
  async discardPrevious(id: string, actor: RootActor): Promise<BackupRestore> {
    const row = await this.prisma.backupRestore.findUnique({ where: { id } });
    if (!row || row.setAside.length === 0 || row.setAsideDeletedAt) {
      throw new NotFoundException(apiError('Nothing set aside', BACKUP_ERROR_CODES.restoreNotFound));
    }
    for (const path of row.setAside) {
      const outcome = await this.rootPrograms.backupDiscard(path, actor);
      // Already gone (deleted by hand): fine.
      if (!outcome.ok && outcome.code !== BACKUP_ERROR_CODES.restoreNotFound) {
        throw backupError(outcome.code);
      }
    }
    const updated = await this.prisma.backupRestore.update({
      where: { id },
      data: { setAsideDeletedAt: new Date() },
    });
    this.notify();
    return this.view(updated);
  }

  view(row: BackupRestoreRow, lastLines?: number): BackupRestore {
    const live = this.following.get(row.id);
    const output = live ? live.output : row.output ? row.output.split('\n') : [];
    return {
      id: row.id,
      itemId: row.itemId,
      archive: row.archive,
      targetPath: row.targetPath,
      setAside: row.setAside,
      setAsideDeleted: row.setAsideDeletedAt !== null,
      status: row.status,
      phase: (live?.phase ?? row.phase ?? null) as BackupRestorePhase | null,
      errorCode: row.errorCode,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      output: lastLines === undefined ? output : output.slice(-lastLines),
    };
  }

  // Inside.

  private follow(id: string): void {
    this.following.set(id, { phase: null, output: [] });
    this.timer ??= setInterval(() => void this.readAll(), RESTORE_POLL_MS);
  }

  private async readAll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      for (const id of [...this.following.keys()]) await this.read(id);
    } catch (error) {
      this.logger.error('Could not follow a restore', error);
    } finally {
      this.reading = false;
      if (this.following.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
  }

  private async read(id: string): Promise<void> {
    const row = await this.prisma.backupRestore.findUnique({ where: { id } });
    if (!row || row.status !== 'running') {
      this.following.delete(id);
      return;
    }
    const events = await this.backupFiles.restoreEvents(id);
    const age = Date.now() - row.startedAt.getTime();
    if (events === null) {
      // Its unit never started.
      if (age > RESTORE_START_GRACE_MS) await this.finish(row, { phase: null, output: [] }, null);
      return;
    }
    const state = summarize(events);
    const previous = this.following.get(id);
    const done = events.findLast((e) => e.type === 'done');
    if (done?.type === 'done') {
      await this.finish(row, state, done);
      return;
    }
    const pid = events.find((e) => e.type === 'start');
    const alive = pid?.type === 'start' && processAlive(pid.pid);
    if ((!alive && age > RESTORE_START_GRACE_MS) || age > MAX_RUN_MS) {
      await this.finish(row, state, null);
      return;
    }
    this.following.set(id, state);
    if (previous?.phase !== state.phase || previous?.output.length !== state.output.length) {
      this.notify();
    }
  }

  /** Saves its result (`done` null: it ended without one — interrupted). */
  private async finish(
    row: BackupRestoreRow,
    state: Following,
    done: Extract<RestoreEvent, { type: 'done' }> | null,
  ): Promise<void> {
    this.following.delete(row.id);
    try {
      await this.prisma.backupRestore.update({
        where: { id: row.id },
        data: {
          status: done ? done.status : 'interrupted',
          phase: state.phase,
          errorCode: done ? done.errorCode : BACKUP_ERROR_CODES.interrupted,
          // Folders set aside are kept even when starting the app afterwards failed: they're the way back.
          setAside: done?.setAside ?? [],
          output: state.output.join('\n'),
          finishedAt: new Date(),
        },
      });
      await this.prune();
    } catch (failure) {
      this.logger.error(`Could not save the result of restore ${row.id}`, failure);
    }
    this.notify();
  }

  private notify(): void {
    this.changed.next();
  }

  /** Old restores go — but never one whose set-aside folders are still there (the list of them). */
  private async prune(): Promise<void> {
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

function summarize(events: RestoreEvent[]): Following {
  let phase: BackupRestorePhase | null = null;
  const output: string[] = [];
  for (const event of events) {
    if (event.type === 'phase') phase = event.phase;
    else if (event.type === 'line') output.push(event.text);
  }
  return { phase, output: output.slice(-BACKUP_LIMITS.progressLines * 20) };
}
