import type { PublicUser } from '@ilex/shared';

/** Who asks for an action, for the audit log. */
export interface ContainerActionActor {
  user: PublicUser;
  ip?: string;
}
