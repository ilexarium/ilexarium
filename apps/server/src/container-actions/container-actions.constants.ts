import { HttpStatus } from '@nestjs/common';
import type { ContainerActionErrorCode } from '@laris/shared';
import type { ContainerActionFailure } from '../docker/docker.model.js';

/** Per IP: plenty for clicking through the menu, not for a script stopping everything in a loop. */
export const ACTION_LIMIT = { default: { limit: 20, ttl: 60_000 } };

export const FAILURE_CODES: Record<ContainerActionFailure, ContainerActionErrorCode> = {
  not_found: 'container_not_found',
  failed: 'action_failed',
  unavailable: 'docker_unavailable',
};

/** 403, not 401, for a protected one: only a 401 signs the web app out. */
export const ERRORS: Record<ContainerActionErrorCode, [HttpStatus, string]> = {
  container_not_found: [HttpStatus.NOT_FOUND, 'No such container'],
  container_protected: [HttpStatus.FORBIDDEN, 'This container is protected'],
  docker_unavailable: [HttpStatus.SERVICE_UNAVAILABLE, 'Docker is not reachable'],
  action_failed: [HttpStatus.BAD_GATEWAY, 'Docker refused the action'],
};
