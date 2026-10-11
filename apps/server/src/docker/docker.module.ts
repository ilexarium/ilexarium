import { Module } from '@nestjs/common';
import { DockerService } from './docker.service.js';

/** Read-only Docker access through the socket proxy (`DOCKER_HOST`). */
@Module({
  providers: [DockerService],
  exports: [DockerService],
})
export class DockerModule {}
