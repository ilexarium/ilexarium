import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ActivityModule } from './activity/activity.module.js';
import { AlertsModule } from './alerts/alerts.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BackupsModule } from './backups/backups.module.js';
import { DisksModule } from './disks/disks.module.js';
import { FilesModule } from './files/files.module.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { ZodValidationPipe } from './common/zod-validation.pipe.js';
import { ConfigModule } from './config/config.module.js';
import { ContainerActionsModule } from './container-actions/container-actions.module.js';
import { ContainerLogsModule } from './container-logs/container-logs.module.js';
import { ContainersModule } from './containers/containers.module.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProcessesModule } from './processes/processes.module.js';
import { SystemJournalModule } from './system-journal/system-journal.module.js';
import { SystemServicesModule } from './system-services/system-services.module.js';
import { ProfileModule } from './profile/profile.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { AppsModule } from './apps/apps.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { SystemMetricsModule } from './system-metrics/system-metrics.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    JobsModule,
    AuditModule,
    AuthModule,
    HealthModule,
    UsersModule,
    ProfileModule,
    RealtimeModule,
    SystemMetricsModule,
    ContainersModule,
    ContainerLogsModule,
    ContainerActionsModule,
    CatalogModule,
    AppsModule,
    BackupsModule,
    DisksModule,
    AlertsModule,
    ActivityModule,
    ProcessesModule,
    SystemServicesModule,
    SystemJournalModule,
    FilesModule,
    TerminalModule,
  ],
  providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }],
})
export class AppModule {}
