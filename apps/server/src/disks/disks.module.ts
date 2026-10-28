import { Module } from '@nestjs/common';
import { HostModule } from '../host/host.module.js';
import { LinuxSessionsModule } from '../linux-sessions/linux-sessions.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RootProgramsModule } from '../root-programs/root-programs.module.js';
import { DiskManager } from './disk-manager.js';
import { DisksController } from './disks.controller.js';
import { DisksTopic } from './disks-topic.js';

/** Disk management (docs/plans/disk_management.md): the disks, mounting, the `disks` topic. */
@Module({
  imports: [HostModule, LinuxSessionsModule, RealtimeModule, RootProgramsModule],
  controllers: [DisksController],
  providers: [DiskManager, DisksTopic],
  exports: [DiskManager],
})
export class DisksModule {}
