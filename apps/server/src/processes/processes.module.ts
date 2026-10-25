import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DockerModule } from '../docker/docker.module.js';
import { HostModule } from '../host/host.module.js';
import { LinuxSessionsModule } from '../linux-sessions/linux-sessions.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ProcessesController } from './processes.controller.js';
import { ProcessesService } from './processes.service.js';
import { ProcessesTopic } from './processes-topic.js';

/** The process list (docs/plans/process_list.md): the `processes` topic and ending a process. */
@Module({
  imports: [AuditModule, DockerModule, HostModule, LinuxSessionsModule, RealtimeModule],
  controllers: [ProcessesController],
  providers: [ProcessesService, ProcessesTopic],
})
export class ProcessesModule {}
