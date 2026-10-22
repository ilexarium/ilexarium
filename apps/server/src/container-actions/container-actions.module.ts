import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DockerModule } from '../docker/docker.module.js';
import { ContainerActionsController } from './container-actions.controller.js';
import { ContainerActionsService } from './container-actions.service.js';

@Module({
  imports: [DockerModule, AuditModule],
  controllers: [ContainerActionsController],
  providers: [ContainerActionsService],
  exports: [ContainerActionsService],
})
export class ContainerActionsModule {}
