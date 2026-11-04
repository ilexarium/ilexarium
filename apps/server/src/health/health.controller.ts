import { Controller, Get } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import type { HealthResponse } from '@laris/shared';
import { LARIS_VERSION } from '../common/laris-version.js';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      // An update waits for the new one; the web app reloads when it changes.
      version: LARIS_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
