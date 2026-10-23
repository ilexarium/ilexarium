import { TERMINAL_CLOSE_CODES } from '@laris/shared';
import type { TerminalClosedReason } from '../terminal.model';

/** `WebSocket.OPEN`, without needing the global (tests use a fake socket). */
export const OPEN = 1;

/** What the page says for each way the terminal's socket closes. */
export const CLOSE_REASONS: Record<number, TerminalClosedReason> = {
  [TERMINAL_CLOSE_CODES.exited]: 'exited',
  [TERMINAL_CLOSE_CODES.replaced]: 'replaced',
  [TERMINAL_CLOSE_CODES.linuxSessionEnded]: 'linuxSessionEnded',
  [TERMINAL_CLOSE_CODES.ticketRefused]: 'ticketRefused',
};
