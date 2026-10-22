import { Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module.js';
import { ContainerLogsController } from './container-logs.controller.js';
import { ContainerLogStreams } from './container-log-streams.js';

/** docs/plans/container_logs_sse.md */
@Module({
  imports: [DockerModule],
  controllers: [ContainerLogsController],
  providers: [ContainerLogStreams],
})
export class ContainerLogsModule {}
