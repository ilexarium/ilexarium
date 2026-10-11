import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resetDatabase } from '../../test/database.js';
import { ConfigModule } from '../config/config.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditModule } from './audit.module.js';
import { AuditService } from './audit.service.js';

describe('AuditService (database)', () => {
  let audit: AuditService;
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule, AuditModule],
    }).compile();
    await moduleRef.init();
    audit = moduleRef.get(AuditService);
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
  });

  beforeEach(() => resetDatabase(prisma));
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => close());

  it('records an entry with all fields', async () => {
    await audit.record({
      action: 'auth.login',
      outcome: 'failure',
      username: 'owner',
      ip: '192.168.1.66',
      details: { reason: 'invalid_credentials' },
    });
    const [event] = await prisma.auditEvent.findMany();
    expect(event).toMatchObject({
      action: 'auth.login',
      outcome: 'failure',
      userId: null,
      username: 'owner',
      ip: '192.168.1.66',
      details: { reason: 'invalid_credentials' },
    });
    expect(event.id[14]).toBe('7'); // UUIDv7
    expect(event.at).toBeInstanceOf(Date);
  });

  it('accepts IPv6 addresses', async () => {
    await audit.record({ action: 'auth.logout', outcome: 'success', ip: '::1' });
    expect((await prisma.auditEvent.findFirstOrThrow()).ip).toBe('::1');
  });

  it('refuses details that look like secrets', async () => {
    for (const key of ['password', 'newPassword', 'setupToken', 'passwordHash', 'cookie']) {
      await expect(
        audit.record({ action: 'auth.login', outcome: 'failure', details: { [key]: 'x' } }),
      ).rejects.toThrow(/secrets/);
    }
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it('record() rejects when the entry cannot be stored (fail closed)', async () => {
    await expect(
      audit.record({ action: 'auth.login', outcome: 'failure', ip: 'not-an-ip' }),
    ).rejects.toThrow();
  });

  it('tryRecord() logs and carries on when the entry cannot be stored', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(
      audit.tryRecord({ action: 'auth.login', outcome: 'failure', ip: 'not-an-ip' }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0][0])).toContain('auth.login/failure');
  });
});
