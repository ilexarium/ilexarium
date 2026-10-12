import { Module } from '@nestjs/common';
import { DockerControl } from './docker-control.js';
import { DockerService } from './docker.service.js';

/**
 * Docker access through the socket proxy (`DOCKER_HOST`): `DockerService` reads, `DockerControl`
 * makes the three container actions — nothing else changes Docker.
 */
@Module({
  providers: [DockerService, DockerControl],
  exports: [DockerService, DockerControl],
})
export class DockerModule {}
