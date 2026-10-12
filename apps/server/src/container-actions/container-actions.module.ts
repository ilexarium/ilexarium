import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DockerModule } from '../docker/docker.module.js';
import { ContainerActionsController } from './container-actions.controller.js';
import { ContainerActionsService } from './container-actions.service.js';

/** Start, stop and restart a container (`POST /api/containers/:name/:action`). */
@Module({
  imports: [DockerModule, AuditModule],
  controllers: [ContainerActionsController],
  providers: [ContainerActionsService],
})
export class ContainerActionsModule {}
