import { z } from 'zod';
import { BACKUP_ARCHIVE_PATTERN } from '@ilex/shared';
import type { RecoveryRecord } from './backup-recovery.model.js';

const recordSchema = z.object({
  id: z.uuid(),
  status: z.enum(['succeeded', 'failed']),
  errorCode: z.string().max(100).nullable(),
  archive: z.string().regex(BACKUP_ARCHIVE_PATTERN),
  archiveTime: z.iso.datetime(),
  askedBy: z.number().int().min(0),
  finishedAt: z.iso.datetime(),
  accounts: z
    .array(
      z.object({
        uid: z.number().int().min(0),
        name: z.string().max(64),
        items: z.array(z.string().max(1024)).max(200),
      }),
    )
    .max(1000)
    .nullable(),
});

/** The file's content, checked; null when it isn't one the program wrote. */
export function readRecoveryRecord(text: string): RecoveryRecord | null {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
