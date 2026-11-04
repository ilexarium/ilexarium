import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RootProgramsModule } from '../root-programs/root-programs.module.js';
import { ReleaseCheck } from './release-check.js';
import { UpdateJobs } from './update-jobs.js';
import { UpdatePlaces } from './update-places.js';
import { UpdatesController } from './updates.controller.js';
import { UpdatesService } from './updates.service.js';
import { UpdatesTopic } from './updates-topic.js';

/**
 * Laris's own updates (docs/plans/install_and_update.md): the daily check of the signed release
 * folder, starting an update through the person's sudo, following laris-update's job files.
 */
@Module({
  imports: [AuditModule, JobsModule, RealtimeModule, RootProgramsModule],
  controllers: [UpdatesController],
  providers: [ReleaseCheck, UpdateJobs, UpdatePlaces, UpdatesService, UpdatesTopic],
})
export class UpdatesModule {}
