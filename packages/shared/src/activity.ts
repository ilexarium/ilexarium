import { z } from 'zod';
import { alertSchema } from './alerts.js';
import { backupRunStatusSchema, backupTriggerSchema } from './backups.js';

/**
 * The audit actions the dashboard's "Recent activity" shows (successes only). Sign-ins, files,
 * the terminal and ending processes are left out on purpose: private or noisy.
 */
export const ACTIVITY_ACTIONS = [
  'app.install',
  'app.update',
  'app.remove',
  'container.start',
  'container.stop',
  'container.restart',
  'backup.configure',
  'backup.restore',
  'disk.mount',
  'disk.unmount',
] as const;
export const activityActionSchema = z.enum(ACTIVITY_ACTIONS);
export type ActivityAction = z.infer<typeof activityActionSchema>;

/** How many events the dashboard shows. */
export const ACTIVITY_LIMIT = 20;

export const activityItemSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('action'),
    id: z.string(),
    at: z.iso.datetime(),
    action: activityActionSchema,
    /** Who did it (a snapshot of the username); null if not recorded. */
    username: z.string().nullable(),
    /** What it was done to: a service's name, a container, a disk or a model; null if none. */
    subject: z.string().nullable(),
  }),
  z.object({
    source: z.literal('backup'),
    id: z.string(),
    at: z.iso.datetime(),
    trigger: backupTriggerSchema,
    status: backupRunStatusSchema.exclude(['running']),
  }),
  z.object({
    source: z.literal('alert'),
    id: z.string(),
    at: z.iso.datetime(),
    event: z.enum(['opened', 'closed']),
    alert: alertSchema,
  }),
]);
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const activityResponseSchema = z.object({ items: z.array(activityItemSchema) });
export type ActivityResponse = z.infer<typeof activityResponseSchema>;
