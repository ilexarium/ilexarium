import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DockerModule } from '../docker/docker.module.js';
import { LinuxSessionsModule } from '../linux-sessions/linux-sessions.module.js';
import { AppManager } from './app-manager.js';
import { AppTasks } from './app-tasks.js';
import { AppsController } from './apps.controller.js';
import { RegistryTags } from './registry-tags.js';

/** Apps: Compose folders run as the signed-in Linux account (docs/plans/acting_as_you.md). */
@Module({
  imports: [AuditModule, CatalogModule, DockerModule, LinuxSessionsModule],
  controllers: [AppsController],
  providers: [AppManager, AppTasks, RegistryTags],
  exports: [AppManager],
})
export class AppsModule {}
