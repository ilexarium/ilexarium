import { z } from 'zod';
import { existingPasswordSchema } from './auth.js';

/**
 * The web terminal: a shell of the signed-in Linux
 * account over the Linux session's SSH connection, on a WebSocket of its own — raw bytes both
 * ways (binary frames), JSON control messages as text frames.
 */

/** The terminal's own WebSocket (the realtime socket's limits don't fit typing and output). */
export const TERMINAL_PATH = '/api/terminal';

export const TERMINAL_LIMITS = {
  /** One frame from the browser at most (a large paste arrives in several). */
  maxMessageBytes: 64 * 1024,
  /** A ticket is good for this long, once. */
  ticketSeconds: 30,
  maxCols: 500,
  maxRows: 200,
} as const;

/** Why the server closed the terminal (WebSocket close codes, 4000–4999 are the app's). */
export const TERMINAL_CLOSE_CODES = {
  /** The shell ended (`exit`). */
  exited: 4000,
  /** The ticket was missing, used, expired or for another session: ask for the password again. */
  ticketRefused: 4001,
  /** The Linux session ended (idle, closed, the SSH server gone). */
  linuxSessionEnded: 4003,
  /** A terminal opened elsewhere in this app session took its place. */
  replaced: 4009,
  /** The app session ended — like an HTTP 401 (same code as the realtime socket's). */
  sessionEnded: 4401,
} as const;

/** `POST /api/terminal/ticket`: the app password again, for a one-time ticket. */
export const terminalTicketRequestSchema = z.strictObject({ password: existingPasswordSchema });
export type TerminalTicketRequest = z.infer<typeof terminalTicketRequestSchema>;

export const terminalTicketSchema = z.object({ ticket: z.string() });
export type TerminalTicket = z.infer<typeof terminalTicketSchema>;

/** Text frames from the browser. */
export const terminalControlSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(TERMINAL_LIMITS.maxCols),
    rows: z.number().int().min(1).max(TERMINAL_LIMITS.maxRows),
  }),
]);
export type TerminalControl = z.infer<typeof terminalControlSchema>;

/** The terminal's size when opening: `?ticket=…&cols=…&rows=…`. */
export const terminalOpenQuerySchema = z.object({
  ticket: z.string().min(1).max(100),
  cols: z.coerce.number().int().min(1).max(TERMINAL_LIMITS.maxCols),
  rows: z.coerce.number().int().min(1).max(TERMINAL_LIMITS.maxRows),
});
