import { Body, Controller, HttpCode, Ip, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PublicUser } from '@ilex/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { ProcessSignalDto } from './processes.dto.js';
import { CHANGE_LIMIT } from './processes.constants.js';
import { ProcessesService } from './processes.service.js';

/**
 * The process list (docs/plans/process_list.md). Every route needs a session; ending a process
 * also a Linux session (403 `linux_session_required`).
 */
@Controller('processes')
@UseFilters(TooManyAttemptsFilter)
export class ProcessesController {
  constructor(private readonly processesService: ProcessesService) {}

  /**
   * Ends a process (TERM) or forces it (KILL) as the signed-in Linux account — another account's
   * through its unlocked sudo (403 `sudo_required` while locked).
   */
  @Post('signal')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  signal(
    @Body() body: ProcessSignalDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.processesService.signal(session.id, body, { user, ip });
  }
}
