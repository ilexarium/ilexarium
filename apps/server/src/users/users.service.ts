import { Injectable } from '@nestjs/common';
import type { PublicUser } from '@homelab/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { publicUserSelect, toPublicUser } from './public-user.js';

/** What login and password change need to verify a password. Never returned by the API. */
export interface UserCredentials {
  id: string;
  username: string;
  passwordHash: string;
}

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

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }
}
