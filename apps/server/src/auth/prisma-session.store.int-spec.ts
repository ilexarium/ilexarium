import type { SessionRecord, SessionStore } from '@nestjs/authentication';
import { AuthenticationStorage } from '@nestjs/authentication';
import { authenticationStoreContract } from '@nestjs/authentication/testing';
import { Test } from '@nestjs/testing';
import { resetDatabase } from '../../test/database.js';
import { ConfigModule } from '../config/config.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PrismaSessionStore } from './prisma-session.store.js';

let prisma: PrismaService;
let close: () => Promise<void>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule],
  }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
  close = () => moduleRef.close();
  await resetDatabase(prisma);
});

afterAll(() => close());

/**
 * Test-only adapter. The package's contract suite invents user ids like `user-<uuid>` with no
 * User row; our Session.userId is a UUID with a foreign key. The adapter creates a matching User
 * row and translates ids at the boundary — every other argument and result passes straight
 * through to the real PrismaSessionStore.
 */
function withContractUserIds(store: SessionStore): SessionStore {
  const toDb = (userId: string) => userId.replace(/^user-/, '');
  const fromDb = (record: SessionRecord): SessionRecord => ({
    ...record,
    userId: `user-${record.userId}`,
  });
  const ensureUser = async (userId: string) => {
    const id = toDb(userId);
    await prisma.user.createMany({
      data: [{ id, username: `contract-${id}`, passwordHash: 'unused' }],
      skipDuplicates: true,
    });
    return id;
  };
  return {
    getSession: async (id) => {
      const record = await store.getSession(id);
      return record && fromDb(record);
    },
    createSession: async (record) =>
      store.createSession({ ...record, userId: await ensureUser(record.userId) }),
    touchSession: (id, lastActiveAt) => store.touchSession(id, lastActiveAt),
    deleteSession: (id) => store.deleteSession(id),
    listUserSessions: async (userId) => (await store.listUserSessions(toDb(userId))).map(fromDb),
    deleteUserSessions: (userId) => store.deleteUserSessions(toDb(userId)),
  };
}

const cases = authenticationStoreContract(
  () => ({
    sessions: withContractUserIds(new PrismaSessionStore(prisma, new AuthenticationStorage())),
  }),
  { contracts: ['sessions'], concurrent: true },
);

describe('PrismaSessionStore passes the @nestjs/authentication store contract', () => {
  for (const contractCase of cases) {
    it(contractCase.name, () => contractCase.run());
  }
});
