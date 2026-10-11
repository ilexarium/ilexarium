import { Injectable } from '@nestjs/common';
import type { PublicUser } from '@homelab/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { publicUserSelect, toPublicUser } from './public-user.js';
import type { UserCredentials } from './users.model.js';

/** Arbitrary constant identifying the "create the first user" advisory lock. */
const FIRST_USER_LOCK_KEY = 4_401_001;

/** Usernames are stored lowercase; normalise here too so uniqueness never depends on the caller. */
function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Owns the User table. Everything returns public fields only, except `findCredentials()`,
 * which is for verifying a password (login, password change) and nothing else.
 */
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

  /**
   * Creates the first (owner) account — only if no user exists yet. An advisory lock serialises
   * concurrent attempts, so two simultaneous setups can never both create an owner.
   * Resolves `null` when a user already exists.
   */
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
}
