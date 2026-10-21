import { Injectable } from '@nestjs/common';
import type { ProfilePictureType, PublicUser } from '@homelab/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { publicUserSelect, toPublicUser } from './public-user.js';
import type { ProfileFields, StoredAvatar, UserCredentials } from './users.model.js';

/** Any constant: the "create the first user" advisory lock. */
const FIRST_USER_LOCK_KEY = 4_401_001;

/** Usernames are stored lowercase; normalise here too so uniqueness never depends on the caller. */
function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Everything returns public fields only, except `findCredentials()`: for checking a password. */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async hasAnyUser(): Promise<boolean> {
    return (await this.prisma.user.findFirst({ select: { id: true } })) !== null;
  }

  async findById(id: string): Promise<PublicUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: publicUserSelect });
    return user && toPublicUser(user);
  }

  async findByUsername(username: string): Promise<PublicUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { username: normaliseUsername(username) },
      select: publicUserSelect,
    });
    return user && toPublicUser(user);
  }

  findCredentials(username: string): Promise<UserCredentials | null> {
    return this.prisma.user.findUnique({
      where: { username: normaliseUsername(username) },
      select: { id: true, username: true, passwordHash: true },
    });
  }

  async create(input: { username: string; passwordHash: string }): Promise<PublicUser> {
    const user = await this.prisma.user.create({
      data: { username: normaliseUsername(input.username), passwordHash: input.passwordHash },
      select: publicUserSelect,
    });
    return toPublicUser(user);
  }

  /** `null` when a user exists already. The lock means two setups at once can't both win. */
  async createFirstUser(input: {
    username: string;
    passwordHash: string;
  }): Promise<PublicUser | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_USER_LOCK_KEY})`;
      if (await tx.user.findFirst({ select: { id: true } })) return null;
      const user = await tx.user.create({
        data: { username: normaliseUsername(input.username), passwordHash: input.passwordHash },
        select: publicUserSelect,
      });
      return toPublicUser(user);
    });
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  async updateProfile(id: string, profile: ProfileFields): Promise<PublicUser> {
    const user = await this.prisma.user.update({
      where: { id },
      data: profile,
      select: publicUserSelect,
    });
    return toPublicUser(user);
  }

  /** Only bytes `inspectPicture` has checked. */
  async setAvatar(id: string, bytes: Buffer, type: ProfilePictureType): Promise<PublicUser> {
    const avatar = { bytes: new Uint8Array(bytes), type, updatedAt: new Date() };
    const user = await this.prisma.user.update({
      where: { id },
      data: { avatar: { upsert: { create: avatar, update: avatar } } },
      select: publicUserSelect,
    });
    return toPublicUser(user);
  }

  async removeAvatar(id: string): Promise<PublicUser> {
    await this.prisma.userAvatar.deleteMany({ where: { userId: id } });
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: publicUserSelect,
    });
    return toPublicUser(user);
  }

  findAvatar(id: string): Promise<StoredAvatar | null> {
    return this.prisma.userAvatar.findUnique({
      where: { userId: id },
      select: { bytes: true, type: true, updatedAt: true },
    });
  }
}
