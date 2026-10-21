import type { UserLanguage } from '@homelab/shared';

/** What login and password change need to verify a password. Never returned by the API. */
export interface UserCredentials {
  id: string;
  username: string;
  passwordHash: string;
}

/** `null` removes a name or an address; a missing one stays as it is. */
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
