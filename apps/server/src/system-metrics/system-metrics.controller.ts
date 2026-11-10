import { Controller, Get } from '@nestjs/common';
import type { HostInfo } from '@ilex/shared';
import { SystemMetricsService } from './system-metrics.service.js';

@Controller('system')
export class SystemMetricsController {
  constructor(private readonly systemMetricsService: SystemMetricsService) {}

  @Get('host')
  host(): Promise<HostInfo> {
    return this.systemMetricsService.host();
  }
}
