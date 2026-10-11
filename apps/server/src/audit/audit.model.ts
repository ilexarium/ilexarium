import type { AuditOutcome, Prisma } from '../generated/prisma/client.js';
import type { AuditAction } from './audit-actions.js';

export interface AuditEntry {
  action: AuditAction;
  outcome: AuditOutcome;
  userId?: string;
  /** Snapshot at the time of the event, so the log still reads well after renames/deletes. */
  username?: string;
  ip?: string;
  /** Action-specific extras. Never secrets: keys that look like one are refused. */
  details?: Record<string, Prisma.InputJsonValue>;
}
