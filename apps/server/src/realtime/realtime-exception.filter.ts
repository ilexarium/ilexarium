import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  Injectable,
  Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { RealtimeConnections } from './realtime-connections.js';
import { DropMessageException, RealtimeException, sendMessage } from './realtime-messages.js';

/**
 * Turns everything a message handler (or its guards and pipes) throws into our protocol, in place
 * of Nest's generic `exception` event:
 *
 * - the authentication guard's 401 (session ended) → close with `4401`;
 * - the validation pipe's 400 → `error` `invalid_message`;
 * - {@link RealtimeException} → its `error`; {@link DropMessageException} → nothing;
 * - anything else → logged; the client gets nothing (no internals leak).
 */
@Catch()
@Injectable()
export class RealtimeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(RealtimeExceptionFilter.name);

  constructor(private readonly realtimeConnections: RealtimeConnections) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<WebSocket>();
    if (exception instanceof DropMessageException) return;
    if (exception instanceof RealtimeException) {
      sendMessage(client, { event: 'error', data: exception.error });
    } else if (exception instanceof BadRequestException) {
      sendMessage(client, { event: 'error', data: RealtimeException.invalidMessage().error });
    } else if (isUnauthorized(exception)) {
      this.realtimeConnections.closeForEndedSession(client);
    } else {
      this.logger.error('A WebSocket message failed', (exception as Error)?.stack);
    }
  }
}

/** The authentication guard refuses a ws message with a `WsException` carrying `statusCode: 401`. */
function isUnauthorized(exception: unknown): boolean {
  if (!(exception instanceof WsException)) return false;
  const error = exception.getError();
  return (
    typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 401
  );
}
