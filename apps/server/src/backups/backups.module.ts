import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DockerModule } from '../docker/docker.module.js';
import { HostModule } from '../host/host.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RootProgramsModule } from '../root-programs/root-programs.module.js';
import { BackupChecks } from './backup-checks.js';
import { BackupPlanManager } from './backup-plan-manager.js';
import { BackupJobs } from './backup-jobs.js';
import { BackupRestores } from './backup-restores.js';
import { BackupRuns } from './backup-runs.js';
import { BackupStatusReader } from './backup-status-reader.js';
import { BackupsController } from './backups.controller.js';
import { BackupsTopic } from './backups-topic.js';

/**
 * Automated backups (docs/plans/backups.md): changes through the person's sudo, results from the
 * backup program's files. The health alerts read the status and follow its changes.
 */
@Module({
  imports: [AuditModule, DockerModule, HostModule, RealtimeModule, RootProgramsModule],
  controllers: [BackupsController],
  providers: [
    BackupChecks,
    BackupJobs,
    BackupPlanManager,
    BackupRestores,
    BackupRuns,
    BackupStatusReader,
    BackupsTopic,
  ],
  exports: [BackupJobs, BackupPlanManager, BackupRuns, BackupStatusReader],
})
export class BackupsModule {}
