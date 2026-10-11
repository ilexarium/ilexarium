import { Injectable, Logger } from '@nestjs/common';
import type { AuditOutcome, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
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

const SECRET_LIKE_KEY = /pass(word)?|secret|token|hash|cookie/i;

/**
 * The audit log: who did what, when, and whether it worked. Append-only by convention —
 * this service is the only code that touches the table, and it only inserts (and later reads).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an entry and **rejects if it can't** — the default for anything privileged:
   * a caller that can't record its action must not perform it (fail closed).
   */
  async record(entry: AuditEntry): Promise<void> {
    const secretKey = Object.keys(entry.details ?? {}).find((key) => SECRET_LIKE_KEY.test(key));
    if (secretKey) {
      throw new Error(`Audit details must not contain secrets (key "${secretKey}")`);
    }
    await this.prisma.auditEvent.create({
      data: {
        action: entry.action,
        outcome: entry.outcome,
        userId: entry.userId,
        username: entry.username,
        ip: entry.ip,
        details: entry.details,
      },
    });
  }

  /**
   * Records an entry; on failure logs the error and carries on. Only for events where
   * availability matters more than the record (auth: a broken audit table must not lock
   * everyone out). Never for privileged host actions.
   */
  async tryRecord(entry: AuditEntry): Promise<void> {
    try {
      await this.record(entry);
    } catch (error) {
      this.logger.error(`Could not record audit event ${entry.action}/${entry.outcome}`, error);
    }
  }
}
