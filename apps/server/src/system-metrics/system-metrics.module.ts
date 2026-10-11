import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SystemMetricsService } from './system-metrics.service.js';
import { SystemReader } from './system-reader.js';

/** The `system` realtime topic: host CPU, memory, network, disks. */
@Module({
  imports: [RealtimeModule],
  providers: [
    // Factory: its optional root argument is for container mode, not for injection.
    { provide: SystemReader, useFactory: () => new SystemReader() },
    SystemMetricsService,
  ],
})
export class SystemMetricsModule {}
