import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { HostModule } from '../host/host.module.js';
import { SystemMetricsController } from './system-metrics.controller.js';
import { SystemMetricsService } from './system-metrics.service.js';

@Module({
  imports: [HostModule, RealtimeModule],
  controllers: [SystemMetricsController],
  providers: [SystemMetricsService],
})
export class SystemMetricsModule {}
