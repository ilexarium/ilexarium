import { REALTIME_ERROR_CODES, type RealtimeError, type ServerMessage } from '@ilex/shared';
import { WebSocket } from 'ws';
import { MAX_BUFFERED_BYTES } from './realtime.constants.js';
import type { RealtimeClient } from './realtime.model.js';

/** Sends one typed message; silently skipped if the socket is no longer open or is backed up. */
export function sendMessage(client: RealtimeClient, message: ServerMessage): void {
  if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_BUFFERED_BYTES) return;
  client.send(JSON.stringify(message));
}

/** A protocol error the client can act on; `RealtimeExceptionFilter` sends it as an `error` message. */
export class RealtimeException extends Error {
  constructor(readonly error: RealtimeError) {
    super(error.message);
  }

  static invalidMessage(): RealtimeException {
    return new RealtimeException({
      code: REALTIME_ERROR_CODES.invalidMessage,
      message: 'Invalid message',
    });
  }

  static rateLimited(): RealtimeException {
    return new RealtimeException({
      code: REALTIME_ERROR_CODES.rateLimited,
      message: 'Too many messages. Slow down.',
    });
  }
}

/** Drops the message without a reply (a connection that was refused or just got closed). */
export class DropMessageException extends Error {}
