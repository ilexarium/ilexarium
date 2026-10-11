import { Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ContainersService } from './containers.service.js';

/** The `containers` realtime topic: every container's state and live resource use. */
@Module({
  imports: [DockerModule, RealtimeModule],
  providers: [ContainersService],
})
export class ContainersModule {}
