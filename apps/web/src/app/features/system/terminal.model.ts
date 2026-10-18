/** Where the terminal page is: no Linux session is handled before these. */
export type TerminalPhase = 'locked' | 'connecting' | 'open' | 'closed';

/** Why the terminal closed — `terminal.closed.<reason>` in the translations. */
export type TerminalClosedReason =
  'exited' | 'replaced' | 'linuxSessionEnded' | 'ticketRefused' | 'lost' | 'closed';

/** The terminal's size in characters. */
export interface TerminalSize {
  cols: number;
  rows: number;
}
