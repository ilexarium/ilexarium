import type { PublicUser } from '@homelab/shared';

/** Who changes their profile, for the audit log. */
export interface ProfileActor {
  user: PublicUser;
  ip: string;
}
