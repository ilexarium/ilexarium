import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { RealtimeConnections } from './realtime-connections.js';
import { DropMessageException, RealtimeException } from './realtime-messages.js';

/**
 * Runs on every message after the global authentication guard: drops messages on sockets that
 * are not (or not yet) admitted — waiting for the admission first — and applies the rate limit.
 */
@Injectable()
export class RealtimeGuard implements CanActivate {
  constructor(private readonly realtimeConnections: RealtimeConnections) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<WebSocket>();
    const connection = await this.realtimeConnections.admitted(client);
    if (!connection) throw new DropMessageException();
    switch (connection.limiter.hit()) {
      case 'allowed':
        return true;
      case 'limited':
        throw RealtimeException.rateLimited();
      case 'abusive':
        this.realtimeConnections.closeForViolation(client, 'Too many messages');
        throw new DropMessageException();
    }
  }
}
