import type { PublicUser } from '@homelab/shared';

/** Prisma `select` for the public user fields. The only shape that may leave the server. */
export const publicUserSelect = { id: true, username: true, createdAt: true } as const;

export function toPublicUser(user: { id: string; username: string; createdAt: Date }): PublicUser {
  return { id: user.id, username: user.username, createdAt: user.createdAt.toISOString() };
}
