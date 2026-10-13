import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DockerModule } from '../docker/docker.module.js';
import { ExecutorModule } from '../executor/executor.module.js';
import { HostModule } from '../host/host.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { ServiceJobs } from './service-jobs.js';
import { ServiceSecrets } from './service-secrets.js';
import { ServicesTopic } from './services-topic.js';
import { ServicesController } from './services.controller.js';
import { ServicesService } from './services.service.js';

/** Installing and removing catalog services (docs/plans/service_deploys.md). */
@Module({
  imports: [CatalogModule, DockerModule, ExecutorModule, HostModule, RealtimeModule, SecretsModule],
  controllers: [ServicesController],
  providers: [ServicesService, ServiceJobs, ServiceSecrets, ServicesTopic],
})
export class ServicesModule {}
