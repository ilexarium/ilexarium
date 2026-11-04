import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DockerModule } from '../docker/docker.module.js';
import { DockerCleanupController } from './docker-cleanup.controller.js';
import { DockerCleanupService } from './docker-cleanup.service.js';

@Module({
  imports: [DockerModule, AuditModule],
  controllers: [DockerCleanupController],
  providers: [DockerCleanupService],
})
export class DockerCleanupModule {}
