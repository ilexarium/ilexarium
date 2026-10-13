import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { HostModule } from '../host/host.module.js';
import { SystemMetricsService } from './system-metrics.service.js';

/** The `system` realtime topic: host CPU, memory, network, disks. */
@Module({
  imports: [HostModule, RealtimeModule],
  providers: [SystemMetricsService],
})
export class SystemMetricsModule {}
