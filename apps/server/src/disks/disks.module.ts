import { Module } from '@nestjs/common';
import { ExecutorModule } from '../executor/executor.module.js';
import { HostModule } from '../host/host.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { DiskManager } from './disk-manager.js';
import { DisksController } from './disks.controller.js';
import { DisksTopic } from './disks-topic.js';

/** Disk management (docs/plans/disk_management.md): the disks, mounting, the `disks` topic. */
@Module({
  imports: [ExecutorModule, HostModule, JobsModule, RealtimeModule],
  controllers: [DisksController],
  providers: [DiskManager, DisksTopic],
})
export class DisksModule {}
