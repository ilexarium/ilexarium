import { Controller, Get } from '@nestjs/common';
import type { HostInfo } from '@laris/shared';
import { SystemMetricsService } from './system-metrics.service.js';

/** The machine itself, for the whole app (the top bar); its live values are the `system` topic. */
@Controller('system')
export class SystemMetricsController {
  constructor(private readonly systemMetricsService: SystemMetricsService) {}

  @Get('host')
  host(): Promise<HostInfo> {
    return this.systemMetricsService.host();
  }
}
