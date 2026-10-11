import { z } from 'zod';
import {
  containersSnapshotSchema,
  containersUpdateSchema,
  systemSnapshotSchema,
  systemUpdateSchema,
} from './monitoring.js';

/** The app's single WebSocket, same origin as the API. */
export const REALTIME_PATH = '/api/ws';

export const WS_CLOSE_CODES = {
  /** The session ended while connected — the web app treats it like an HTTP 401. */
  sessionEnded: 4401,
} as const;

export const REALTIME_TOPICS = ['system', 'containers'] as const;
export const realtimeTopicSchema = z.enum(REALTIME_TOPICS);
export type RealtimeTopic = z.infer<typeof realtimeTopicSchema>;

// Client → server. Strict: anything else is rejected with an `invalid_message` error.

export const clientMessageSchema = z.strictObject({
  type: z.enum(['subscribe', 'unsubscribe']),
  topic: realtimeTopicSchema,
});
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// Server → client.

export const REALTIME_ERROR_CODES = {
  invalidMessage: 'invalid_message',
  rateLimited: 'rate_limited',
} as const;
export type RealtimeErrorCode = (typeof REALTIME_ERROR_CODES)[keyof typeof REALTIME_ERROR_CODES];

/** Sent once on subscribe: the current values plus history, so charts start filled. */
const snapshotMessageSchema = z.discriminatedUnion('topic', [
  z.object({ type: z.literal('snapshot'), topic: z.literal('system'), data: systemSnapshotSchema }),
  z.object({
    type: z.literal('snapshot'),
    topic: z.literal('containers'),
    data: containersSnapshotSchema,
  }),
]);

const updateMessageSchema = z.discriminatedUnion('topic', [
  z.object({ type: z.literal('update'), topic: z.literal('system'), data: systemUpdateSchema }),
  z.object({
    type: z.literal('update'),
    topic: z.literal('containers'),
    data: containersUpdateSchema,
  }),
]);

const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.enum([REALTIME_ERROR_CODES.invalidMessage, REALTIME_ERROR_CODES.rateLimited]),
  message: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  snapshotMessageSchema,
  updateMessageSchema,
  errorMessageSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type SnapshotMessage = Extract<ServerMessage, { type: 'snapshot' }>;
export type UpdateMessage = Extract<ServerMessage, { type: 'update' }>;
export type ErrorMessage = Extract<ServerMessage, { type: 'error' }>;
