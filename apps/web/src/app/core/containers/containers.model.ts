import type { ContainerAction } from '@ilex/shared';

/** One action on several containers of an app, said in one toast in the app's name. */
export interface ContainerGroupAction {
  names: string[];
  action: ContainerAction;
  label: string;
}
