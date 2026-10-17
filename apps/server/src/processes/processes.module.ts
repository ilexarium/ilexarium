import { Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module.js';
import { ExecutorModule } from '../executor/executor.module.js';
import { HostModule } from '../host/host.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ProcessesController } from './processes.controller.js';
import { ProcessesService } from './processes.service.js';
import { ProcessesTopic } from './processes-topic.js';

/** The process list (docs/plans/process_list.md): the `processes` topic and ending a process. */
@Module({
  imports: [DockerModule, ExecutorModule, HostModule, RealtimeModule],
  controllers: [ProcessesController],
  providers: [ProcessesService, ProcessesTopic],
})
export class ProcessesModule {}
