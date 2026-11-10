import { Controller, Get } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import type { HealthResponse } from '@ilex/shared';
import { ILEX_VERSION } from '../common/ilex-version.js';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      // An update waits for the new one; the web app reloads when it changes.
      version: ILEX_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
