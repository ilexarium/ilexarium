import {
  HttpException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  type ApiErrorResponse,
  UPDATE_ERROR_CODES,
  type UpdateCheckError,
  type UpdateErrorCode,
  type UpdatesStatus,
} from '@ilex/shared';
import { exhaustMap, type Observable, Subject, type Subscription, timer } from 'rxjs';
import { ILEX_VERSION } from '../common/ilex-version.js';
import { safely } from '../common/safely.js';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RootPrograms } from '../root-programs/root-programs.js';
import type { RootActor } from '../root-programs/root-programs.model.js';
import { ReleaseCheck } from './release-check.js';
import { isNewer } from './release-manifest.js';
import { UpdateJobs } from './update-jobs.js';
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_AFTER_MS,
  UPDATE_CHECK_ID,
  UPDATE_ERROR_STATUS,
} from './updates.constants.js';

function updateError(code: UpdateErrorCode): HttpException {
  const body: ApiErrorResponse = { message: 'The update could not be started', code };
  return new HttpException(body, UPDATE_ERROR_STATUS[code]);
}

/**
 * Ilexarium's own updates: the daily check (on by default; the
 * release host sees this machine's address once a day), the switch, and starting an update
 * through the person's sudo. The update itself is ilex-update's, followed by UpdateJobs.
 */
@Injectable()
export class UpdatesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UpdatesService.name);
  private readonly changed = new Subject<void>();
  readonly changes$: Observable<void> = this.changed.asObservable();
  private schedule: Subscription | null = null;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly releaseCheck: ReleaseCheck,
    private readonly updateJobs: UpdateJobs,
    private readonly rootPrograms: RootPrograms,
    private readonly changesUnderway: ChangesUnderway,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule = timer(FIRST_CHECK_AFTER_MS, CHECK_EVERY_MS)
      .pipe(
        exhaustMap(() =>
          safely(
            () => this.scheduledCheck(),
            (error) => this.logger.warn(`The update check failed: ${(error as Error).message}`),
          ),
        ),
      )
      .subscribe();
  }

  onModuleDestroy(): void {
    this.schedule?.unsubscribe();
  }

  async status(): Promise<UpdatesStatus> {
    const [source, row] = await Promise.all([
      this.releaseCheck.source(),
      this.prisma.updateCheck.findUnique({ where: { id: UPDATE_CHECK_ID } }),
    ]);
    const available =
      row?.availableVersion && isNewer(row.availableVersion, ILEX_VERSION)
        ? {
            version: row.availableVersion,
            published: row.availablePublished ?? '',
            notes: row.availableNotes,
          }
        : null;
    return {
      configured: source !== null,
      installed: ILEX_VERSION,
      available,
      newestPublished: row?.newestPublished ?? null,
      checkedAt: row?.checkedAt?.toISOString() ?? null,
      checkError: (row?.checkError as UpdateCheckError | null) ?? null,
      checkAutomatically: row?.checkAutomatically ?? true,
      job: this.updateJobs.latest(),
    };
  }

  /** Checks now (one check at a time: a second request waits for the running one). */
  check(): Promise<void> {
    this.checking ??= this.checkOnce().finally(() => (this.checking = null));
    return this.checking;
  }

  async setCheckAutomatically(checkAutomatically: boolean): Promise<void> {
    await this.prisma.updateCheck.upsert({
      where: { id: UPDATE_CHECK_ID },
      create: { id: UPDATE_CHECK_ID, checkAutomatically },
      update: { checkAutomatically },
    });
    this.changed.next();
  }

  /** Starts the update to the newest checked release, as the person (their sudo). */
  async start(version: string, actor: RootActor): Promise<{ id: string }> {
    const status = await this.status();
    if (!status.configured) throw updateError(UPDATE_ERROR_CODES.notConfigured);
    if (status.available?.version !== version) throw updateError(UPDATE_ERROR_CODES.notAvailable);
    // The installer stops the app and the platform: not in the middle of a backup, a restore, an
    // app's task or another update (each tells ChangesUnderway).
    if (this.changesUnderway.anyApp()) {
      throw updateError(UPDATE_ERROR_CODES.busy);
    }
    const id = randomUUID();
    // Before the installer's database dump: a rollback keeps who started it.
    await this.prisma.updateRun.create({
      data: {
        id,
        fromVersion: ILEX_VERSION,
        toVersion: version,
        userId: actor.user.id,
        username: actor.user.username,
        ip: actor.ip ?? null,
      },
    });
    let started: Awaited<ReturnType<RootPrograms['updateStart']>>;
    try {
      started = await this.rootPrograms.updateStart(id, version, actor);
    } catch (error) {
      await this.prisma.updateRun.delete({ where: { id } });
      throw error;
    }
    if (!started.ok) {
      await this.prisma.updateRun.delete({ where: { id } });
      throw updateError(started.code);
    }
    await this.updateJobs.refresh();
    return { id };
  }

  private async scheduledCheck(): Promise<void> {
    const row = await this.prisma.updateCheck.findUnique({ where: { id: UPDATE_CHECK_ID } });
    if (row && !row.checkAutomatically) return;
    // Restarts don't add checks: once a day.
    if (row?.checkedAt && Date.now() - row.checkedAt.getTime() < CHECK_EVERY_MS / 2) return;
    await this.check();
  }

  private async checkOnce(): Promise<void> {
    const source = await this.releaseCheck.source();
    if (!source) return;
    const result = await this.releaseCheck.newest(source);
    const checkedAt = new Date();
    const data = result.ok
      ? {
          checkedAt,
          checkError: null,
          newestPublished: result.newest.published,
          ...(isNewer(result.newest.version, ILEX_VERSION)
            ? {
                availableVersion: result.newest.version,
                availablePublished: result.newest.published,
                availableNotes: result.notes,
              }
            : { availableVersion: null, availablePublished: null, availableNotes: null }),
        }
      : // A failed check keeps what the last good one found.
        { checkedAt, checkError: result.error };
    await this.prisma.updateCheck.upsert({
      where: { id: UPDATE_CHECK_ID },
      create: { id: UPDATE_CHECK_ID, ...data },
      update: data,
    });
    this.changed.next();
  }
}
