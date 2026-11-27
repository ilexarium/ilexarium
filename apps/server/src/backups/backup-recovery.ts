import { ConflictException, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BACKUP_ERROR_CODES,
  type BackupRecovery,
  type BackupRecoveryCheckRequest,
  type BackupRecoveryCheckResponse,
  type BackupRecoveryRequest,
} from '@ilex/shared';
import { AuditService } from '../audit/audit.service.js';
import { SystemReader } from '../host/system-reader.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProgramConfigService } from '../root-programs/program-config.js';
import type { RootActor } from '../root-programs/root-programs.model.js';
import { backupCodeOf } from '../root-programs/root-programs.constants.js';
import { RootPrograms } from '../root-programs/root-programs.js';
import { apiError, programCall } from './backup-errors.js';
import { stateDir } from './backup-paths.js';
import type { RecoveryRecord } from './backup-recovery.model.js';
import { readRecoveryRecord } from './backup-recovery-record.js';
import { RECOVERY_FILE } from './backups.constants.js';

/**
 * Restoring Ilexarium from the backup disk (docs/plans/recover_from_backup.md): the backups found,
 * the start (its own unit, which stops this app and replaces its database), and the result the
 * backup program leaves in `recovery.json` — recorded in the audit log once, at startup, in the
 * database that's there then (the restored one, or the one kept after a failure); its notice
 * shown until dismissed.
 */
@Injectable()
export class BackupRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupRecoveryService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly rootPrograms: RootPrograms,
    private readonly programConfigService: ProgramConfigService,
    private readonly systemReader: SystemReader,
    private readonly auditService: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.recordOnce();
    } catch (error) {
      this.logger.error('Could not record the last recovery', error);
    }
  }

  check(
    request: BackupRecoveryCheckRequest,
    actor: RootActor,
  ): Promise<BackupRecoveryCheckResponse> {
    return programCall(() => this.rootPrograms.backupRecoverCheck(request, actor));
  }

  /** Only while there's no backup plan: a machine set up already is recovered from a terminal. */
  async start(request: BackupRecoveryRequest, actor: RootActor): Promise<{ recoveryId: string }> {
    if (await this.prismaService.backupPlan.findUnique({ where: { id: 1 } })) {
      throw new ConflictException(
        apiError('Backups are set up here already', BACKUP_ERROR_CODES.alreadyConfigured),
      );
    }
    const recoveryId = randomUUID();
    await programCall(() =>
      this.rootPrograms.backupRecoverStart({ recoveryId, ...request }, actor),
    );
    return { recoveryId };
  }

  /** The last recovery here, its accounts compared with this machine's as they are now. */
  async recovery(): Promise<BackupRecovery | null> {
    const record = await this.read();
    if (!record) return null;
    await this.recordOnce(record);
    const [row, users] = await Promise.all([
      this.prismaService.backupRecovery.findUnique({ where: { id: record.id } }),
      this.systemReader.users(),
    ]);
    return {
      id: record.id,
      status: record.status,
      errorCode:
        record.errorCode && (backupCodeOf(record.errorCode) ?? BACKUP_ERROR_CODES.recoveryFailed),
      archive: record.archive,
      archiveTime: record.archiveTime,
      finishedAt: record.finishedAt,
      accounts:
        record.accounts?.map((account) => ({ ...account, here: users.get(account.uid) ?? null })) ??
        null,
      dismissed: row?.dismissedAt != null,
    };
  }

  async dismiss(): Promise<void> {
    const record = await this.read();
    if (!record) return;
    await this.prismaService.backupRecovery.upsert({
      where: { id: record.id },
      create: { id: record.id, dismissedAt: new Date() },
      update: { dismissedAt: new Date() },
    });
  }

  private async read(): Promise<RecoveryRecord | null> {
    const file = join(stateDir(this.programConfigService.config), RECOVERY_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    return readRecoveryRecord(text);
  }

  /**
   * Its audit entry, once per recovery (its row says it was written): who started it is a Linux
   * account (the program's word), named as this machine names it.
   */
  private async recordOnce(known?: RecoveryRecord): Promise<void> {
    const record = known ?? (await this.read());
    if (!record) return;
    if (await this.prismaService.backupRecovery.findUnique({ where: { id: record.id } })) return;
    try {
      await this.prismaService.backupRecovery.create({ data: { id: record.id } });
    } catch {
      return; // recorded meanwhile (a request at startup)
    }
    const users = await this.systemReader.users();
    await this.auditService.tryRecord({
      action: 'backup.recover_result',
      outcome: record.status === 'succeeded' ? 'success' : 'failure',
      username: users.get(record.askedBy) ?? `uid ${record.askedBy}`,
      details: {
        recoveryId: record.id,
        archive: record.archive,
        ...(record.errorCode && { reason: record.errorCode }),
      },
    });
  }
}
