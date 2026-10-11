import { Injectable } from '@nestjs/common';
import {
  AuthenticationStorage,
  type MfaState,
  type SessionRecord,
  type SessionStore,
} from '@nestjs/authentication';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { publicUserSelect, toPublicUser } from '../users/public-user.js';
import './authentication-types.js';

type SessionRow = Prisma.SessionGetPayload<object>;

/** Optional fields come back absent (`undefined`), never `null` — a store contract rule. */
function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastActiveAt: row.lastActiveAt,
    ...(row.mfa !== null && { mfa: row.mfa as MfaState }),
    ...(row.metadata !== null && { metadata: row.metadata as Record<string, unknown> }),
  };
}

/**
 * The package's session storage, on Prisma. Follows its store contract: conditional writes as
 * single statements (counted), times from the package's clock, never the database's.
 */
@Injectable()
export class PrismaSessionStore implements SessionStore {
  constructor(
    private readonly prisma: PrismaService,
    storage: AuthenticationStorage,
  ) {
    storage.registerSource({ sessions: this });
  }

  /** Reads the session and its user (public fields only) in one query, for `SessionAuth`. */
  async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = await this.prisma.session.findUnique({
      where: { id },
      include: { user: { select: publicUserSelect } },
    });
    if (!row) return undefined;
    const { user, ...session } = row;
    return { ...toRecord(session), extra: { user: toPublicUser(user) } };
  }

  /** A plain insert; also clears sessions past their absolute expiry so the table stays bounded. */
  async createSession(record: SessionRecord): Promise<void> {
    await this.prisma.session.deleteMany({ where: { expiresAt: { lte: record.createdAt } } });
    await this.prisma.session.create({
      data: {
        id: record.id,
        userId: record.userId,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        lastActiveAt: record.lastActiveAt,
        mfa: record.mfa,
        metadata: record.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /** One conditional write: only an existing session, and only forward. Never an upsert. */
  async touchSession(id: string, lastActiveAt: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id, lastActiveAt: { lt: lastActiveAt } },
      data: { lastActiveAt },
    });
  }

  /** Resolves whether this call deleted it: of two racing deletes, only one wins. */
  async deleteSession(id: string): Promise<boolean> {
    const { count } = await this.prisma.session.deleteMany({ where: { id } });
    return count > 0;
  }

  async listUserSessions(userId: string): Promise<SessionRecord[]> {
    const rows = await this.prisma.session.findMany({ where: { userId } });
    return rows.map(toRecord);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId } });
  }
}
