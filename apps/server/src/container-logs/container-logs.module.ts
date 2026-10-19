import { Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module.js';
import { ContainerLogsController } from './container-logs.controller.js';
import { ContainerLogStreams } from './container-log-streams.js';

/**
 * Container logs as Server-Sent Events (`GET /api/containers/:name/logs`), see
 * docs/plans/container_logs_sse.md.
 */
@Module({
  imports: [DockerModule],
  controllers: [ContainerLogsController],
  providers: [ContainerLogStreams],
})
export class ContainerLogsModule {}
