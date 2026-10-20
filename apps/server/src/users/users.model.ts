import type { UserLanguage } from '@homelab/shared';

/** What login and password change need to verify a password. Never returned by the API. */
export interface UserCredentials {
  id: string;
  username: string;
  passwordHash: string;
}

/** The profile's own fields; `null` removes a name or an address, a missing one stays. */
export interface ProfileFields {
  displayName?: string | null;
  email?: string | null;
  language?: UserLanguage;
}

/** The picture as stored: checked bytes, the type judged from them. */
export interface StoredAvatar {
  bytes: Uint8Array;
  type: string;
  updatedAt: Date;
}

/** A user as `publicUserSelect` reads it, before `toPublicUser`. */
export interface PublicUserRow {
  id: string;
  username: string;
  createdAt: Date;
  displayName: string | null;
  email: string | null;
  language: string | null;
  avatar: { updatedAt: Date } | null;
}
