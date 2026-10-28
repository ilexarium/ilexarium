import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BackupsModule } from '../backups/backups.module.js';
import { ContainerActionsModule } from '../container-actions/container-actions.module.js';
import { DisksModule } from '../disks/disks.module.js';
import { DockerModule } from '../docker/docker.module.js';
import { RootProgramsModule } from '../root-programs/root-programs.module.js';
import { HostModule } from '../host/host.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { AlertChannels } from './alert-channels.js';
import { AlertNotifier } from './alert-notifier.js';
import { AlertRecords } from './alert-records.js';
import { AlertWatcher } from './alert-watcher.js';
import { AlertsController } from './alerts.controller.js';
import { AlertsTopic } from './alerts-topic.js';

/**
 * Health alerts (docs/plans/health_alerts.md): the always-on watcher, the `Alert` table, the
 * messages by email and ntfy, the `alerts` topic and Settings → Notifications.
 */
@Module({
  imports: [
    AuditModule,
    BackupsModule,
    ContainerActionsModule,
    DisksModule,
    DockerModule,
    RootProgramsModule,
    HostModule,
    JobsModule,
    RealtimeModule,
    SecretsModule,
  ],
  controllers: [AlertsController],
  providers: [AlertChannels, AlertNotifier, AlertRecords, AlertWatcher, AlertsTopic],
})
export class AlertsModule {}
