import { Controller, HttpCode, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentSession } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PersonCheck } from '@ilex/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { CHECK_LIMIT } from './machine-check.constants.js';
import { MachineCheckService } from './machine-check.service.js';

/** The checks done as the signed-in Linux account (403 `linux_session_required` without one). */
@Controller('machine-check')
@UseFilters(TooManyAttemptsFilter)
export class MachineCheckController {
  constructor(private readonly machineCheckService: MachineCheckService) {}

  @Post('person')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHECK_LIMIT)
  person(@CurrentSession() session: { id: string }): Promise<PersonCheck> {
    return this.machineCheckService.person(session.id);
  }
}
