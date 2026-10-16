import { z } from 'zod';
import {
  containersSnapshotSchema,
  containersUpdateSchema,
  systemSnapshotSchema,
  systemUpdateSchema,
} from './monitoring.js';
import { logsCloseSchema, logsEndSchema, logsLinesSchema, logsOpenSchema } from './logs.js';
import { servicesListSchema } from './services.js';
import { backupsStatusSchema } from './backups.js';
import { disksStatusSchema } from './disks.js';

/** The app's single WebSocket, same origin as the API. */
export const REALTIME_PATH = '/api/ws';

export const WS_CLOSE_CODES = {
  /**
   * No session when connecting, or it ended while connected — the web app treats it like an
   * HTTP 401 (back to login). Other refusals (wrong origin, too many connections) use 1008.
   */
  sessionEnded: 4401,
} as const;

export const REALTIME_TOPICS = ['system', 'containers', 'services', 'backups', 'disks'] as const;
export const realtimeTopicSchema = z.enum(REALTIME_TOPICS);
export type RealtimeTopic = z.infer<typeof realtimeTopicSchema>;

// Messages use Nest's `{ event, data }` format in both directions.

// Client → server.

/** `data` of `subscribe` and `unsubscribe`. Strict: anything else is an `invalid_message`. */
export const topicRequestSchema = z.strictObject({ topic: realtimeTopicSchema });
export type TopicRequest = z.infer<typeof topicRequestSchema>;

export const clientMessageSchema = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('subscribe'), data: topicRequestSchema }),
  z.strictObject({ event: z.literal('unsubscribe'), data: topicRequestSchema }),
  z.strictObject({ event: z.literal('logs:open'), data: logsOpenSchema }),
  z.strictObject({ event: z.literal('logs:close'), data: logsCloseSchema }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// Server → client.

export const REALTIME_ERROR_CODES = {
  invalidMessage: 'invalid_message',
  rateLimited: 'rate_limited',
  /** A `logs:open` beyond `LOG_LIMITS.maxStreamsPerConnection`. */
  tooManyStreams: 'too_many_streams',
} as const;
export type RealtimeErrorCode = (typeof REALTIME_ERROR_CODES)[keyof typeof REALTIME_ERROR_CODES];

export const realtimeErrorSchema = z.object({
  code: z.enum([
    REALTIME_ERROR_CODES.invalidMessage,
    REALTIME_ERROR_CODES.rateLimited,
    REALTIME_ERROR_CODES.tooManyStreams,
  ]),
  message: z.string(),
});
export type RealtimeError = z.infer<typeof realtimeErrorSchema>;

/** `<topic>:snapshot` is sent once on subscribe — current values plus history, so charts start filled. */
export const serverMessageSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('system:snapshot'), data: systemSnapshotSchema }),
  z.object({ event: z.literal('system:update'), data: systemUpdateSchema }),
  z.object({ event: z.literal('containers:snapshot'), data: containersSnapshotSchema }),
  z.object({ event: z.literal('containers:update'), data: containersUpdateSchema }),
  z.object({ event: z.literal('services:snapshot'), data: servicesListSchema }),
  z.object({ event: z.literal('services:update'), data: servicesListSchema }),
  z.object({ event: z.literal('backups:snapshot'), data: backupsStatusSchema }),
  z.object({ event: z.literal('backups:update'), data: backupsStatusSchema }),
  z.object({ event: z.literal('disks:snapshot'), data: disksStatusSchema }),
  z.object({ event: z.literal('disks:update'), data: disksStatusSchema }),
  z.object({ event: z.literal('logs:lines'), data: logsLinesSchema }),
  z.object({ event: z.literal('logs:end'), data: logsEndSchema }),
  z.object({ event: z.literal('error'), data: realtimeErrorSchema }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerEvent = ServerMessage['event'];
/** The `data` type of a server event, e.g. `ServerEventData<'system:update'>`. */
export type ServerEventData<E extends ServerEvent> = Extract<ServerMessage, { event: E }>['data'];
