import type { ContainerAction, PublicUser } from '@laris/shared';

/** Who asks for an action, for the audit log. */
export interface ContainerActionActor {
  user: PublicUser;
  ip?: string;
}

/** An action about to be done to a container. */
export interface ContainerActionRequest {
  action: ContainerAction;
  name: string;
}
