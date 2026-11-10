import { HttpStatus } from '@nestjs/common';
import { CONTAINER_ACTION_ERROR_CODES, type ContainerActionErrorCode } from '@ilex/shared';
import type { ContainerActionFailure } from '../docker/docker.model.js';

/** Per IP: plenty for clicking through the menu, not for a script stopping everything in a loop. */
export const ACTION_LIMIT = { default: { limit: 20, ttl: 60_000 } };

export const FAILURE_CODES: Record<ContainerActionFailure, ContainerActionErrorCode> = {
  not_found: CONTAINER_ACTION_ERROR_CODES.notFound,
  failed: CONTAINER_ACTION_ERROR_CODES.actionFailed,
  unavailable: CONTAINER_ACTION_ERROR_CODES.dockerUnavailable,
};

/** 403, not 401, for a protected one: only a 401 signs the web app out. */
export const ERRORS: Record<ContainerActionErrorCode, [HttpStatus, string]> = {
  container_not_found: [HttpStatus.NOT_FOUND, 'No such container'],
  container_protected: [HttpStatus.FORBIDDEN, 'This container is protected'],
  docker_unavailable: [HttpStatus.SERVICE_UNAVAILABLE, 'Docker is not reachable'],
  action_failed: [HttpStatus.BAD_GATEWAY, 'Docker refused the action'],
};
