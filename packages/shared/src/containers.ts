import { z } from 'zod';
import { containerNameSchema } from './logs.js';

/**
 * What the app may do to a container: `POST /api/containers/:name/:action`, answered with 204
 * once Docker is done ("already running/stopped" counts as done). Nothing destructive.
 */
export const CONTAINER_ACTIONS = ['start', 'stop', 'restart'] as const;
export const containerActionSchema = z.enum(CONTAINER_ACTIONS);
export type ContainerAction = z.infer<typeof containerActionSchema>;

/** Containers with this label set to `true` can't be stopped or restarted (the platform's own). */
export const PROTECTED_LABEL = 'homelab.protected';

/** Actions refused on a protected container: those that interrupt it. */
export const PROTECTED_ACTIONS: readonly ContainerAction[] = ['stop', 'restart'];

/** The route parameters of a container action. */
export const containerActionParamsSchema = z.strictObject({
  name: containerNameSchema,
  action: containerActionSchema,
});
export type ContainerActionParams = z.infer<typeof containerActionParamsSchema>;

export const CONTAINER_ACTION_ERROR_CODES = {
  notFound: 'container_not_found',
  protected: 'container_protected',
  dockerUnavailable: 'docker_unavailable',
  actionFailed: 'action_failed',
} as const;
export type ContainerActionErrorCode =
  (typeof CONTAINER_ACTION_ERROR_CODES)[keyof typeof CONTAINER_ACTION_ERROR_CODES];
