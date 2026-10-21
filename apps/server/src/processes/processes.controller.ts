import { Body, Controller, HttpCode, Ip, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PublicUser } from '@laris/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { ProcessSignalDto } from './processes.dto.js';
import { ProcessesService } from './processes.service.js';

/** Per IP, for ending processes (privileged); the list itself comes through the topic. */
const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/** The process list (docs/plans/process_list.md). Every route needs a session. */
@Controller('processes')
@UseFilters(TooManyAttemptsFilter)
export class ProcessesController {
  constructor(private readonly processes: ProcessesService) {}

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
    return this.processes.signal(body, { user, ip });
  }
}
