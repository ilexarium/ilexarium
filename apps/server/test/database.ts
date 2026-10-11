import type { PrismaService } from '../src/prisma/prisma.service.js';

/** Empties every table between tests. Only ever runs against the test database. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('resetDatabase refused: DATABASE_URL is not a *_test database');
  }
  await prisma.$executeRaw`TRUNCATE TABLE "AuditEvent", "Session", "User" CASCADE`;
}
