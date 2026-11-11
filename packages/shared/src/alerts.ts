import { z } from 'zod';
import { VALIDATION_LIMITS } from './auth.js';
import { backupWarningSchema } from './backups.js';

/**
 * Health alerts: the platform notices when something goes wrong —
 * a service stopped, a disk filling up, a backup failed — and tells the user in the app and,
 * optionally, by email and ntfy. An alert opens when its problem starts and closes by itself.
 */

/**
 * - `serviceDown`: a container of an installed service (or of the platform) stopped by itself.
 * - `restartLoop`: it restarted 3 times within 10 minutes.
 * - `unhealthy`: its health check has failed for more than 2 minutes.
 * - `outOfMemory`: the kernel killed it for using too much memory (closes after an hour).
 * - `diskFull`: a disk above 90 % for 5 minutes (critical above 97 %).
 * - `diskMissing`: a disk mounted here isn't connected.
 * - `backup`: a backup warning (`BACKUP_WARNINGS`).
 */
export const ALERT_KINDS = [
  'serviceDown',
  'restartLoop',
  'unhealthy',
  'outOfMemory',
  'diskFull',
  'diskMissing',
  'backup',
] as const;
export const alertKindSchema = z.enum(ALERT_KINDS);
export type AlertKind = z.infer<typeof alertKindSchema>;

export const ALERT_SEVERITIES = ['warning', 'critical'] as const;
export const alertSeveritySchema = z.enum(ALERT_SEVERITIES);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

/** The fixed thresholds of v1 (per-rule thresholds in the UI are v2). */
export const ALERT_LIMITS = {
  /** Restarts within `restartWindowMinutes` that make a restart loop. */
  restarts: 3,
  restartWindowMinutes: 10,
  unhealthyMinutes: 2,
  outOfMemoryHours: 1,
  diskFullPercent: 90,
  diskCriticalPercent: 97,
  /** A critical full disk is a warning again below this (so 96–97 % doesn't flip it every minute). */
  diskCriticalClearPercent: 95,
  /** A full disk's alert closes below this. */
  diskClearPercent: 85,
  diskFullMinutes: 5,
  /** Closed alerts are kept this long. */
  keepClosedDays: 30,
  /** Messages sent per hour at most; the rest are grouped into one. */
  messagesPerHour: 10,
} as const;

export const alertSchema = z.object({
  id: z.uuid(),
  kind: alertKindSchema,
  /**
   * What it is about: the container's name (app kinds), the mount point (disk kinds), the
   * warning (`backup`).
   */
  subject: z.string(),
  severity: alertSeveritySchema,
  /** The app (Compose project) the container belongs to; null for the platform's own containers. */
  app: z.string().nullable(),
  /** `diskFull`: how full the disk was, last seen. */
  percent: z.number().min(0).max(100).nullable(),
  /** `backup`: which warning. */
  warning: backupWarningSchema.nullable(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  /** Who acknowledged it (a snapshot of the username). */
  acknowledgedBy: z.string().nullable(),
});
export type Alert = z.infer<typeof alertSchema>;

// Delivery.

export const ALERT_CHANNELS = ['email', 'ntfy'] as const;
export const alertChannelSchema = z.enum(ALERT_CHANNELS);
export type AlertChannel = z.infer<typeof alertChannelSchema>;

/**
 * Why a message couldn't be sent:
 * - `addressRefused`: the address is one the app never sends to (link-local addresses, plain
 *   HTTP to the internet).
 * - `notFound`: the server's name doesn't resolve.
 * - `unreachable`: no connection (refused, no route).
 * - `timedOut`: no answer within 10 seconds.
 * - `tlsFailed`: no encrypted connection (the mail server offers none, or its certificate is invalid).
 * - `loginRefused`: the server refused the user name, password or token.
 * - `rejected`: the server refused the message (a wrong topic, sender or recipient).
 * - `failed`: anything else.
 */
export const DELIVERY_PROBLEMS = [
  'addressRefused',
  'notFound',
  'unreachable',
  'timedOut',
  'tlsFailed',
  'loginRefused',
  'rejected',
  'failed',
] as const;
export const deliveryProblemSchema = z.enum(DELIVERY_PROBLEMS);
export type DeliveryProblem = z.infer<typeof deliveryProblemSchema>;

/** The last message that couldn't be sent through a channel. */
export const deliveryFailureSchema = z.object({
  channel: alertChannelSchema,
  at: z.iso.datetime(),
  problem: deliveryProblemSchema,
});
export type DeliveryFailure = z.infer<typeof deliveryFailureSchema>;

// The `alerts` topic.

export const alertsStatusSchema = z.object({
  /** Open alerts, critical first, then newest first. */
  open: z.array(alertSchema),
  /** Alerts closed within the last 7 days, newest first (at most 50). */
  closed: z.array(alertSchema),
  /** The latest failed delivery of a channel still switched on, or null. */
  deliveryFailure: deliveryFailureSchema.nullable(),
});
export type AlertsStatus = z.infer<typeof alertsStatusSchema>;

// Settings → Notifications.

export const ALERT_ERROR_CODES = {
  alertNotFound: 'alert_not_found',
  /** "Send a test" before the channel was saved. */
  channelNotConfigured: 'channel_not_configured',
  /** The address is one the app never sends to (see `DELIVERY_PROBLEMS.addressRefused`). */
  addressRefused: 'address_refused',
  /** ntfy switched on without a topic. */
  topicRequired: 'topic_required',
  /** A user name without a password. */
  passwordRequired: 'password_required',
  auditUnavailable: 'audit_unavailable',
} as const;
export type AlertErrorCode = (typeof ALERT_ERROR_CODES)[keyof typeof ALERT_ERROR_CODES];

/** A mail server's name or IP address. */
const HOST_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$|^[0-9a-fA-F:.]+$/;
/** One line of printable characters: no spaces at the ends, no control characters. */
const LINE_PATTERN = /^[^\x00-\x1f\x7f]*$/;

export const ALERT_SETTINGS_LIMITS = {
  hostMax: 253,
  usernameMax: 256,
  passwordMax: 512,
  urlMax: 2048,
  tokenMax: 256,
} as const;

/** Any port: mail servers listen on 25, 465 and 587 (services' ports start at 1024). */
const port = z
  .number({ error: 'validation.portInvalid' })
  .int('validation.portInvalid')
  .min(1, 'validation.anyPortRange')
  .max(65535, 'validation.anyPortRange');

const emailAddress = z
  .string()
  .trim()
  .min(1, 'validation.emailRequired')
  .max(VALIDATION_LIMITS.textMax, 'validation.textTooLong')
  .pipe(z.email('validation.emailInvalid'));

/** The mail server's settings as the form edits them: an empty password keeps the stored one. */
export const emailChannelFormSchema = z.strictObject({
  enabled: z.boolean(),
  host: z
    .string()
    .trim()
    .min(1, 'validation.hostRequired')
    .max(ALERT_SETTINGS_LIMITS.hostMax, 'validation.hostInvalid')
    .regex(HOST_PATTERN, 'validation.hostInvalid'),
  port,
  username: z
    .string()
    .trim()
    .max(ALERT_SETTINGS_LIMITS.usernameMax, 'validation.textTooLong')
    .regex(LINE_PATTERN, 'validation.secretInvalid'),
  password: z
    .string()
    .max(ALERT_SETTINGS_LIMITS.passwordMax, 'validation.secretTooLong')
    .regex(LINE_PATTERN, 'validation.secretInvalid'),
  from: emailAddress,
  to: emailAddress,
});
export type EmailChannelForm = z.infer<typeof emailChannelFormSchema>;

/**
 * `PUT /alerts/channels/email`. Port 465 is implicit TLS, any other STARTTLS — required, except
 * to a mail server on this machine. No password: the stored one stays.
 */
export const emailChannelUpdateSchema = emailChannelFormSchema.extend({
  password: emailChannelFormSchema.shape.password.min(1, 'validation.secretInvalid').optional(),
});
export type EmailChannelUpdate = z.infer<typeof emailChannelUpdateSchema>;

/** ntfy's topic names: letters, digits, `-` and `_`. */
const NTFY_TOPIC = /\/[-_A-Za-z0-9]{1,64}$/;

/** A topic URL: server and topic, `https://ntfy.sh/ilex-7f3k9q2m`. Plain HTTP only to private addresses (checked by the server). */
export const ntfyTopicUrlSchema = z
  .string()
  .trim()
  .min(1, 'validation.urlRequired')
  .max(ALERT_SETTINGS_LIMITS.urlMax, 'validation.urlInvalid')
  .pipe(z.url({ protocol: /^https?$/, error: 'validation.urlInvalid' }))
  .refine((value) => {
    // Runs even when the URL check above failed: then there's nothing more to say.
    if (!URL.canParse(value)) return true;
    const url = new URL(value);
    return (
      !url.username && !url.password && !url.search && !url.hash && NTFY_TOPIC.test(url.pathname)
    );
  }, 'validation.ntfyTopicInvalid');

const ntfyToken = z
  .string()
  .trim()
  .max(ALERT_SETTINGS_LIMITS.tokenMax, 'validation.secretTooLong')
  .regex(/^[\x21-\x7e]*$/, 'validation.tokenInvalid');

/** ntfy's settings as the form edits them: empty fields keep the stored values. */
export const ntfyChannelFormSchema = z.strictObject({
  enabled: z.boolean(),
  topicUrl: z.union([z.literal(''), ntfyTopicUrlSchema]),
  token: ntfyToken,
  /** Remove the stored token. */
  clearToken: z.boolean(),
});
export type NtfyChannelForm = z.infer<typeof ntfyChannelFormSchema>;

/** `PUT /alerts/channels/ntfy`. Left out: the stored value stays; `token: null` removes it. */
export const ntfyChannelUpdateSchema = z.strictObject({
  enabled: z.boolean(),
  topicUrl: ntfyTopicUrlSchema.optional(),
  token: ntfyToken.min(1, 'validation.tokenInvalid').nullable().optional(),
});
export type NtfyChannelUpdate = z.infer<typeof ntfyChannelUpdateSchema>;

/** `GET /alerts/channels`: what's set — secrets only as "set". */
export const alertChannelsResponseSchema = z.object({
  email: z
    .object({
      enabled: z.boolean(),
      host: z.string(),
      port: z.number().int(),
      username: z.string(),
      passwordSet: z.boolean(),
      from: z.string(),
      to: z.string(),
      lastFailure: deliveryFailureSchema.nullable(),
    })
    .nullable(),
  ntfy: z
    .object({
      enabled: z.boolean(),
      topicSet: z.boolean(),
      tokenSet: z.boolean(),
      lastFailure: deliveryFailureSchema.nullable(),
    })
    .nullable(),
});
export type AlertChannelsResponse = z.infer<typeof alertChannelsResponseSchema>;

/** `POST /alerts/channels/:channel/test`: sent, or why not. */
export const alertTestResponseSchema = z.object({
  sent: z.boolean(),
  problem: deliveryProblemSchema.nullable(),
});
export type AlertTestResponse = z.infer<typeof alertTestResponseSchema>;

export const alertChannelParamsSchema = z.strictObject({ channel: alertChannelSchema });
export const alertIdParamsSchema = z.strictObject({ id: z.uuid() });
