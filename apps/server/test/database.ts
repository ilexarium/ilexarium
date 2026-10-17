import type { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.schema.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('Refused: DATABASE_URL is not a *_test database');
  }
}

/** Empties every table between tests. Only ever runs against the test database. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  assertTestDatabase();
  await prisma.$executeRaw`TRUNCATE TABLE "Alert", "AlertChannel", "BackupItemResult", "BackupRestore", "BackupRun", "BackupItem", "BackupPlan", "BackupCheck", "AuditEvent", "Session", "ServiceJob", "ServiceSecret", "Service", "User" CASCADE`;
}

/** Same, through its own connection: for tests that need an empty database before the app starts. */
export async function resetDatabaseBeforeStart(): Promise<void> {
  assertTestDatabase();
  const config = { get: () => process.env.DATABASE_URL } as unknown as ConfigService<Env, true>;
  const prisma = new PrismaService(config);
  try {
    await resetDatabase(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
