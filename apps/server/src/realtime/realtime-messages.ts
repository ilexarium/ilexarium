import { REALTIME_ERROR_CODES, type RealtimeError, type ServerMessage } from '@homelab/shared';
import { WebSocket } from 'ws';
import type { RealtimeClient } from './realtime.model.js';

/** Above this much unsent data the client isn't keeping up: updates are skipped, not queued. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** Sends one typed message; silently skipped if the socket is no longer open or is backed up. */
export function sendMessage(client: RealtimeClient, message: ServerMessage): void {
  if (!canSend(client)) return;
  client.send(JSON.stringify(message));
}

/** Open and not backed up — for senders that must know whether a message would be skipped. */
export function canSend(client: RealtimeClient): boolean {
  return client.readyState === WebSocket.OPEN && client.bufferedAmount <= MAX_BUFFERED_BYTES;
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

  static tooManyStreams(): RealtimeException {
    return new RealtimeException({
      code: REALTIME_ERROR_CODES.tooManyStreams,
      message: 'Too many open log views. Close one first.',
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
