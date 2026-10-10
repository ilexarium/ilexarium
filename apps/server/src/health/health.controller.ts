import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@homelab/shared';

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      version: process.env.npm_package_version ?? '0.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
