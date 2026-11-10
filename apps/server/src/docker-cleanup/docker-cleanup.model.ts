import type { PublicUser } from '@ilex/shared';

/** Who frees the space, for the audit log. */
export interface CleanupActor {
  user: PublicUser;
  ip?: string;
}
