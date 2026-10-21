import type { IncomingMessage } from 'node:http';
import { UseFilters, UseGuards } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { REALTIME_PATH } from '@laris/shared';
import type { WebSocket } from 'ws';
import { RealtimeConnections } from './realtime-connections.js';
import { RealtimeExceptionFilter } from './realtime-exception.filter.js';
import { RealtimeSubscriptions } from './realtime-subscriptions.js';
import { TopicRequestDto } from './realtime.dto.js';
import { RealtimeGuard } from './realtime.guard.js';
import { MAX_MESSAGE_BYTES } from './realtime.options.js';

/**
 * The app's single WebSocket (`/api/ws`, on the HTTP server — the global prefix doesn't apply to
 * gateways, hence the full path). Messages are Nest's `{ event, data }`; each one passes the
 * global authentication guard, then {@link RealtimeGuard}, then the global validation pipe.
 * Malformed JSON and unknown events are dropped by Nest before any of that.
 */
@WebSocketGateway({ path: REALTIME_PATH, maxPayload: MAX_MESSAGE_BYTES })
@UseGuards(RealtimeGuard)
@UseFilters(RealtimeExceptionFilter)
export class RealtimeGateway
  implements OnGatewayConnection<WebSocket>, OnGatewayDisconnect<WebSocket>
{
  constructor(
    private readonly connections: RealtimeConnections,
    private readonly subscriptions: RealtimeSubscriptions,
  ) {}

  /** Synchronous up to the admission's first await — see `RealtimeConnections`. */
  handleConnection(client: WebSocket, request: IncomingMessage): Promise<unknown> {
    return this.connections.admit(client, request);
  }

  handleDisconnect(client: WebSocket): void {
    this.connections.release(client);
    this.subscriptions.removeClient(client);
  }

  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: TopicRequestDto,
  ): Promise<void> {
    await this.subscriptions.subscribe(client, body.topic);
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(@ConnectedSocket() client: WebSocket, @MessageBody() body: TopicRequestDto): void {
    this.subscriptions.unsubscribe(client, body.topic);
  }
}
