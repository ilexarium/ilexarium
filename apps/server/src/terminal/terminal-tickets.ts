import { Injectable } from '@nestjs/common';
import { TERMINAL_LIMITS } from '@laris/shared';
import { randomBytes } from 'node:crypto';

interface Ticket {
  appSessionId: string;
  expires: number;
}

/**
 * One-time tickets for opening the terminal: issued after the app password was given again,
 * good once, for 30 seconds, and only for the app session that asked — a stolen session cookie
 * alone opens no shell.
 */
@Injectable()
export class TerminalTickets {
  private readonly tickets = new Map<string, Ticket>();

  issue(appSessionId: string, now = Date.now()): string {
    for (const [key, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(key);
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { appSessionId, expires: now + TERMINAL_LIMITS.ticketSeconds * 1000 });
    return ticket;
  }

  /** Whether the ticket is good for this app session; used up either way. */
  take(ticket: string, appSessionId: string, now = Date.now()): boolean {
    const found = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return !!found && found.expires > now && found.appSessionId === appSessionId;
  }
}
