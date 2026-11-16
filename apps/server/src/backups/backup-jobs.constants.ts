import { BACKUP_LIMITS, backupRestorePhaseSchema } from '@ilex/shared';
import { z } from 'zod';

// What the backup program writes in a job's file (system/programs/backup/files.mts): root-owned,
// still checked.

const uuid = z.uuid();
const status = z.enum(['ok', 'warning', 'failed']);
const errorCode = z.string().max(64).nullable();
const time = z.iso.datetime();

/** Borg's warnings, as the program cuts them (with room to spare). */
const warnings = z.array(z.string().max(1000)).max(50);
const itemResultSchema = z.object({
  itemId: uuid,
  status,
  errorCode,
  archive: z.string().max(128).nullable(),
  originalBytes: z.number().nonnegative().nullable(),
  addedBytes: z.number().nonnegative().nullable(),
  warnings,
  archives: z.array(z.string().max(128)).max(10_000).nullable().optional(),
});
export type ItemResult = z.infer<typeof itemResultSchema>;

const runStartSchema = z.object({
  type: z.literal('run'),
  runId: uuid,
  trigger: z.enum(['scheduled', 'manual']),
  itemId: uuid.nullable(),
  pid: z.number().int().positive(),
  startedAt: time,
  items: z.array(uuid).max(200),
});
const checkStartSchema = z.object({
  type: z.literal('check'),
  checkId: uuid,
  full: z.boolean(),
  pid: z.number().int().positive(),
  startedAt: time,
});
const restoreStartSchema = z.object({
  type: z.literal('restore'),
  restoreId: uuid,
  pid: z.number().int().positive(),
  startedAt: time,
});
const runDoneSchema = z.object({
  type: z.literal('runDone'),
  runId: uuid,
  trigger: z.enum(['scheduled', 'manual']),
  itemId: uuid.nullable(),
  status,
  errorCode,
  startedAt: time,
  finishedAt: time,
  items: z.array(itemResultSchema).max(200),
  output: z.array(z.string().max(4000)).max(500),
});
const checkDoneSchema = z.object({
  type: z.literal('checkDone'),
  checkId: uuid,
  full: z.boolean(),
  status,
  errorCode,
  startedAt: time,
  finishedAt: time,
});
const setAside = z.array(z.string().max(4096)).max(100);
const restoreDoneSchema = z.object({
  type: z.literal('restoreDone'),
  status: z.enum(['succeeded', 'failed']),
  errorCode,
  setAside,
  appWasRunning: z.boolean().default(false),
  warnings: warnings.default([]),
});

export const jobEventSchema = z.discriminatedUnion('type', [
  runStartSchema,
  checkStartSchema,
  restoreStartSchema,
  z.object({ type: z.literal('item'), itemId: uuid, phase: z.string().max(32) }),
  z.object({ type: z.literal('phase'), phase: backupRestorePhaseSchema }),
  z.object({ type: z.literal('line'), itemId: uuid.optional(), text: z.string().max(4000) }),
  z.object({ type: z.literal('itemDone'), result: itemResultSchema }),
  // A restore's folders set aside so far (its end repeats them).
  z.object({ type: z.literal('setAside'), setAside }),
  runDoneSchema,
  checkDoneSchema,
  restoreDoneSchema,
]);
export type JobEvent = z.infer<typeof jobEventSchema>;
export type JobStart = z.infer<
  typeof runStartSchema | typeof checkStartSchema | typeof restoreStartSchema
>;
export type RunDone = z.infer<typeof runDoneSchema>;
export type JobDone = RunDone | z.infer<typeof checkDoneSchema | typeof restoreDoneSchema>;

/** Restores keep more of their output than a run's live view. */
export const RESTORE_LINES = BACKUP_LIMITS.progressLines * 20;

/** A job's file: `<uuid>.jsonl`. */
export const JOB_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
