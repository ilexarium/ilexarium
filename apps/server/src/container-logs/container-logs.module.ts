import { Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ContainerLogStreams } from './container-log-streams.js';

/** Container logs over the WebSocket (`logs:open` / `logs:close`), see docs/plans/container_logs.md. */
@Module({
  imports: [DockerModule, RealtimeModule],
  providers: [ContainerLogStreams],
})
export class ContainerLogsModule {}
