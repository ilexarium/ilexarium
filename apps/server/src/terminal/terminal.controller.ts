import { Body, Controller, HttpCode, Ip, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PublicUser, TerminalTicket } from '@ilex/shared';
import { AuthService } from '../auth/auth.service.js';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { linuxSessionRequired } from '../linux-sessions/linux-session-errors.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { TICKET_LIMIT } from './terminal.constants.js';
import { TerminalTicketDto } from './terminal.dto.js';
import { TerminalTickets } from './terminal-tickets.js';

/** The web terminal's HTTP side (docs/plans/files_and_terminal.md, step 2). */
@Controller('terminal')
@UseFilters(TooManyAttemptsFilter)
export class TerminalController {
  constructor(
    private readonly authService: AuthService,
    private readonly linuxSessions: LinuxSessions,
    private readonly terminalTickets: TerminalTickets,
  ) {}

  /** The app password again, then a one-time ticket for `/api/terminal` (a Linux session needed). */
  @Post('ticket')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(TICKET_LIMIT)
  async ticket(
    @Body() { password }: TerminalTicketDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<TerminalTicket> {
    await this.authService.confirmPassword(user, password, ip);
    if (!this.linuxSessions.current(session.id)) throw linuxSessionRequired();
    return { ticket: this.terminalTickets.issue(session.id) };
  }
}
