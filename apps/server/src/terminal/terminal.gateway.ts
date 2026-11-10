import type { IncomingMessage } from 'node:http';
import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { TERMINAL_LIMITS, TERMINAL_PATH } from '@ilex/shared';
import type { WebSocket } from 'ws';
import { Terminals } from './terminals.js';

/**
 * The terminal's own WebSocket (`/api/terminal`). Raw bytes, so no Nest messages: everything is
 * {@link Terminals}' — admission (origin, session, ticket), the shell, backpressure, closing.
 */
@WebSocketGateway({ path: TERMINAL_PATH, maxPayload: TERMINAL_LIMITS.maxMessageBytes })
export class TerminalGateway implements OnGatewayConnection<WebSocket> {
  constructor(private readonly terminals: Terminals) {}

  handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    return this.terminals.open(client, request);
  }
}
