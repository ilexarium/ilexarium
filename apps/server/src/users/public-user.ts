import { PROFILE_AVATAR_PATH, type PublicUser, userLanguageSchema } from '@homelab/shared';

/** Prisma `select` for the public user fields. The only shape that may leave the server. */
export const publicUserSelect = {
  id: true,
  username: true,
  createdAt: true,
  displayName: true,
  email: true,
  language: true,
  avatar: { select: { updatedAt: true } },
} as const;

export interface PublicUserRow {
  id: string;
  username: string;
  createdAt: Date;
  displayName: string | null;
  email: string | null;
  language: string | null;
  avatar: { updatedAt: Date } | null;
}

export function toPublicUser(user: PublicUserRow): PublicUser {
  const language = userLanguageSchema.safeParse(user.language);
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt.toISOString(),
    displayName: user.displayName,
    email: user.email,
    language: language.success ? language.data : null,
    // Versioned: a new picture is a new address, an unchanged one comes from the cache.
    avatar: user.avatar ? `${PROFILE_AVATAR_PATH}?v=${user.avatar.updatedAt.getTime()}` : null,
  };
}
