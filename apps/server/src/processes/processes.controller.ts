import { Body, Controller, HttpCode, Ip, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PublicUser } from '@laris/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { ProcessSignalAsAdministratorDto, ProcessSignalDto } from './processes.dto.js';
import { ADMINISTRATOR_LIMIT, CHANGE_LIMIT } from './processes.constants.js';
import { ProcessesService } from './processes.service.js';

/**
 * The process list (docs/plans/process_list.md). Every route needs a session; ending a process
 * also a Linux session (403 `linux_session_required`).
 */
@Controller('processes')
@UseFilters(TooManyAttemptsFilter)
export class ProcessesController {
  constructor(private readonly processesService: ProcessesService) {}

  /** Ends a process (TERM) or forces it (KILL) as the signed-in Linux account. */
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

  /** The same through the account's `sudo`; the password is for this one action. */
  @Post('signal-as-administrator')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(ADMINISTRATOR_LIMIT)
  signalAsAdministrator(
    @Body() { password, ...request }: ProcessSignalAsAdministratorDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.processesService.signal(session.id, request, { user, ip }, password);
  }
}
