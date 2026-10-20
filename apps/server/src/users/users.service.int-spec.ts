import { Test } from '@nestjs/testing';
import { publicUserSchema } from '@homelab/shared';
import { resetDatabase } from '../../test/database.js';
import { ConfigModule } from '../config/config.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersModule } from './users.module.js';
import { UsersService } from './users.service.js';

describe('UsersService (database)', () => {
  let users: UsersService;
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule, UsersModule],
    }).compile();
    await moduleRef.init();
    users = moduleRef.get(UsersService);
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
  });

  beforeEach(() => resetDatabase(prisma));
  afterAll(() => close());

  it('creates a user and returns only public fields', async () => {
    const user = await users.create({ username: 'owner', passwordHash: '$scrypt$hash' });
    expect(publicUserSchema.strict().safeParse(user).success).toBe(true);
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('uses time-ordered UUIDv7 ids', async () => {
    const first = await users.create({ username: 'first', passwordHash: 'h' });
    const second = await users.create({ username: 'second', passwordHash: 'h' });
    expect(first.id[14]).toBe('7');
    expect(first.id < second.id).toBe(true);
  });

  it('stores usernames lowercase and finds them case-insensitively', async () => {
    await users.create({ username: '  Owner ', passwordHash: 'h' });
    expect((await users.findByUsername('OWNER'))?.username).toBe('owner');
  });

  it('enforces unique usernames regardless of case', async () => {
    await users.create({ username: 'owner', passwordHash: 'h' });
    await expect(users.create({ username: 'OWNER', passwordHash: 'h' })).rejects.toThrow();
  });

  it('never returns the password hash from public lookups', async () => {
    const { id } = await users.create({ username: 'owner', passwordHash: '$scrypt$hash' });
    for (const user of [await users.findById(id), await users.findByUsername('owner')]) {
      expect(user).not.toBeNull();
      expect(JSON.stringify(user)).not.toContain('$scrypt$hash');
    }
  });

  it('returns credentials only from findCredentials', async () => {
    const { id } = await users.create({ username: 'owner', passwordHash: '$scrypt$hash' });
    expect(await users.findCredentials('Owner')).toEqual({
      id,
      username: 'owner',
      passwordHash: '$scrypt$hash',
    });
  });

  it('returns null for unknown users', async () => {
    expect(await users.findByUsername('nobody')).toBeNull();
    expect(await users.findCredentials('nobody')).toBeNull();
    expect(await users.findById('0192f3a1-7c2e-7a4b-9d1e-3f5a7c9b2d4e')).toBeNull();
  });

  it('updates the password hash', async () => {
    const { id } = await users.create({ username: 'owner', passwordHash: 'old' });
    await users.updatePasswordHash(id, 'new');
    expect((await users.findCredentials('owner'))?.passwordHash).toBe('new');
  });

  it('keeps the profile: a name, an address, a language; null removes them', async () => {
    const { id } = await users.create({ username: 'owner', passwordHash: 'h' });
    const updated = await users.updateProfile(id, {
      displayName: 'Anna',
      email: 'anna@example.com',
      language: 'de',
    });
    expect(updated).toMatchObject({
      displayName: 'Anna',
      email: 'anna@example.com',
      language: 'de',
    });
    expect(await users.findById(id)).toEqual(updated);
    const cleared = await users.updateProfile(id, { displayName: null });
    expect(cleared).toMatchObject({ displayName: null, email: 'anna@example.com' });
  });

  it('keeps one picture per user: replaced, read back, removed; its path versioned', async () => {
    const { id } = await users.create({ username: 'owner', passwordHash: 'h' });
    const first = await users.setAvatar(id, Buffer.from('first'), 'image/webp');
    expect(first.avatar).toMatch(/^\/api\/profile\/avatar\?v=\d+$/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await users.setAvatar(id, Buffer.from('second'), 'image/jpeg');
    expect(second.avatar).not.toBe(first.avatar);
    const stored = await users.findAvatar(id);
    expect(Buffer.from(stored!.bytes).toString()).toBe('second');
    expect(stored!.type).toBe('image/jpeg');
    expect((await users.removeAvatar(id)).avatar).toBeNull();
    expect(await users.findAvatar(id)).toBeNull();
    expect((await users.removeAvatar(id)).avatar).toBeNull(); // idempotent
  });

  it('removes the picture with its user', async () => {
    const { id } = await users.create({ username: 'owner', passwordHash: 'h' });
    await users.setAvatar(id, Buffer.from('x'), 'image/png');
    await prisma.user.delete({ where: { id } });
    expect(await prisma.userAvatar.count()).toBe(0);
  });

  it('reads an unknown stored language as none', async () => {
    const { id } = await users.create({ username: 'owner', passwordHash: 'h' });
    await prisma.user.update({ where: { id }, data: { language: 'fr' } });
    expect((await users.findById(id))?.language).toBeNull();
  });
});
