import { Module } from '@nestjs/common';
import { BackupsModule } from '../backups/backups.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DockerModule } from '../docker/docker.module.js';
import { ExecutorModule } from '../executor/executor.module.js';
import { HostModule } from '../host/host.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { ServiceJobs } from './service-jobs.js';
import { ServiceSecrets } from './service-secrets.js';
import { ServicesTopic } from './services-topic.js';
import { ServicesController } from './services.controller.js';
import { ServiceManager } from './service-manager.js';

/** Installing and removing catalog services (docs/plans/service_deploys.md). */
@Module({
  imports: [
    BackupsModule,
    CatalogModule,
    DockerModule,
    ExecutorModule,
    HostModule,
    JobsModule,
    RealtimeModule,
    SecretsModule,
  ],
  controllers: [ServicesController],
  providers: [ServiceManager, ServiceJobs, ServiceSecrets, ServicesTopic],
})
export class ServicesModule {}
