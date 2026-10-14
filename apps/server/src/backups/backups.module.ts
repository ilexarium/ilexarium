import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ExecutorModule } from '../executor/executor.module.js';
import { HostModule } from '../host/host.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { BackupFiles } from './backup-files.js';
import { BackupManager } from './backup-manager.js';
import { BackupProgressFollower } from './backup-progress.js';
import { BackupRestores } from './backup-restores.js';
import { BackupResults } from './backup-results.js';
import { BackupsController } from './backups.controller.js';
import { BackupsTopic } from './backups-topic.js';

/** Automated backups (docs/plans/backups.md). Services use `BackupManager` for "Include in backups". */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    CatalogModule,
    ExecutorModule,
    HostModule,
    JobsModule,
    RealtimeModule,
  ],
  controllers: [BackupsController],
  providers: [
    BackupFiles,
    BackupManager,
    BackupProgressFollower,
    BackupRestores,
    BackupResults,
    BackupsTopic,
  ],
  exports: [BackupManager],
})
export class BackupsModule {}
