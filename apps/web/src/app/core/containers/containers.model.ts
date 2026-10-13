import type { ContainerAction } from '@homelab/shared';

/** A container action someone chose (and confirmed where needed). */
export interface ContainerActionRequest {
  name: string;
  action: ContainerAction;
}
