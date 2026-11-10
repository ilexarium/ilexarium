import { HttpStatus } from '@nestjs/common';
import { DOCKER_CLEANUP_ERROR_CODES, type DockerCleanupErrorCode } from '@ilex/shared';
import type { CleanupFailure } from '../docker/docker.model.js';

/** Per IP: freeing space is a click now and then, not a loop. */
export const CLEANUP_LIMIT = { default: { limit: 10, ttl: 60_000 } };

export const FAILURE_CODES: Record<CleanupFailure, DockerCleanupErrorCode> = {
  not_found: DOCKER_CLEANUP_ERROR_CODES.volumeNotFound,
  in_use: DOCKER_CLEANUP_ERROR_CODES.volumeInUse,
  failed: DOCKER_CLEANUP_ERROR_CODES.failed,
  unavailable: DOCKER_CLEANUP_ERROR_CODES.dockerUnavailable,
};

/** 403, not 401, for a protected one: only a 401 signs the web app out. */
export const ERRORS: Record<DockerCleanupErrorCode, [HttpStatus, string]> = {
  changes_underway: [HttpStatus.CONFLICT, 'Apps are being changed right now'],
  volume_protected: [HttpStatus.FORBIDDEN, 'This volume belongs to Ilexarium itself'],
  volume_in_use: [HttpStatus.CONFLICT, 'A container uses this volume'],
  volume_not_found: [HttpStatus.NOT_FOUND, 'No such volume'],
  docker_unavailable: [HttpStatus.SERVICE_UNAVAILABLE, 'Docker is not reachable'],
  cleanup_failed: [HttpStatus.BAD_GATEWAY, 'Docker refused to free the space'],
};
