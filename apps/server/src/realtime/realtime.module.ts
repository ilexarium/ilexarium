import { Module } from '@nestjs/common';
import { RealtimeConnections } from './realtime-connections.js';
import { RealtimeExceptionFilter } from './realtime-exception.filter.js';
import { RealtimeLogStreams } from './realtime-log-streams.js';
import { RealtimeSubscriptions } from './realtime-subscriptions.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeGuard } from './realtime.guard.js';
import { DEFAULT_REALTIME_OPTIONS, REALTIME_OPTIONS } from './realtime.options.js';

/**
 * The WebSocket at `/api/ws` (see docs/plans/monitoring_dashboard.md). Feature modules import it
 * and register a `TopicSource` with `RealtimeSubscriptions`; the container-logs feature registers
 * its `LogStreamHandler` with `RealtimeLogStreams` (docs/plans/container_logs.md).
 */
@Module({
  providers: [
    { provide: REALTIME_OPTIONS, useValue: DEFAULT_REALTIME_OPTIONS },
    RealtimeConnections,
    RealtimeSubscriptions,
    RealtimeLogStreams,
    RealtimeGuard,
    RealtimeExceptionFilter,
    RealtimeGateway,
  ],
  exports: [RealtimeSubscriptions, RealtimeLogStreams],
})
export class RealtimeModule {}
