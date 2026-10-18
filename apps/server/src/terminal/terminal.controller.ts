import { Body, Controller, HttpCode, Ip, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { FILES_ERROR_CODES, type PublicUser, type TerminalTicket } from '@homelab/shared';
import { AuthService } from '../auth/auth.service.js';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { linuxError } from '../linux-sessions/linux-sessions.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { TerminalTicketDto } from './terminal.dto.js';
import { TerminalTickets } from './terminal-tickets.js';

/** The app password is checked: few tries. */
const TICKET_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/** The web terminal's HTTP side (docs/plans/files_and_terminal.md, step 2). */
@Controller('terminal')
@UseFilters(TooManyAttemptsFilter)
export class TerminalController {
  constructor(
    private readonly auth: AuthService,
    private readonly linux: LinuxSessions,
    private readonly tickets: TerminalTickets,
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
    await this.auth.confirmPassword(user, password, ip);
    if (!this.linux.current(session.id)) {
      throw linuxError(FILES_ERROR_CODES.linuxSessionRequired, 'Sign in as a Linux user first');
    }
    return { ticket: this.tickets.issue(session.id) };
  }
}
