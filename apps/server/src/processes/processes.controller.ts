import { Body, Controller, HttpCode, Ip, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PublicUser } from '@laris/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { ProcessSignalDto } from './processes.dto.js';
import { CHANGE_LIMIT } from './processes.constants.js';
import { ProcessesService } from './processes.service.js';

/** The process list (docs/plans/process_list.md). Every route needs a session. */
@Controller('processes')
@UseFilters(TooManyAttemptsFilter)
export class ProcessesController {
  constructor(private readonly processesService: ProcessesService) {}

  /** Ends a person's process (TERM), or forces it (KILL). */
  @Post('signal')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  signal(
    @Body() body: ProcessSignalDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.processesService.signal(body, { user, ip });
  }
}
