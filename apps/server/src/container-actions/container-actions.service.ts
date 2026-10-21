import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  type ApiErrorResponse,
  CONTAINER_ACTION_ERROR_CODES,
  type ContainerAction,
  type ContainerActionErrorCode,
  PROTECTED_ACTIONS,
} from '@laris/shared';
import { type Observable, Subject } from 'rxjs';
import { AuditService } from '../audit/audit.service.js';
import type { AuditEntry } from '../audit/audit.model.js';
import { ContainerActionError, DockerControl } from '../docker/docker-control.js';
import { DockerService } from '../docker/docker.service.js';
import type { ContainerActionFailure } from '../docker/docker.model.js';
import type { ContainerActionActor, ContainerActionRequest } from './container-actions.model.js';

const FAILURE_CODES: Record<ContainerActionFailure, ContainerActionErrorCode> = {
  not_found: CONTAINER_ACTION_ERROR_CODES.notFound,
  failed: CONTAINER_ACTION_ERROR_CODES.actionFailed,
  unavailable: CONTAINER_ACTION_ERROR_CODES.dockerUnavailable,
};

const RESPONSES: Record<ContainerActionErrorCode, () => Error> = {
  container_not_found: () =>
    new NotFoundException(error('No such container', 'container_not_found')),
  container_protected: () =>
    new ForbiddenException(error('This container is protected', 'container_protected')),
  docker_unavailable: () =>
    new ServiceUnavailableException(error('Docker is not reachable', 'docker_unavailable')),
  action_failed: () => new BadGatewayException(error('Docker refused the action', 'action_failed')),
};

function error(message: string, code: ContainerActionErrorCode): ApiErrorResponse {
  return { message, code };
}

/**
 * The container actions, in the order every privileged action follows: check (protected
 * containers can't be stopped or restarted), **record the request — or don't act** (fail closed),
 * act, record the outcome.
 */
@Injectable()
export class ContainerActionsService {
  private readonly requested = new Subject<ContainerActionRequest>();

  /**
   * An action is about to happen (recorded, not yet done) — so the health alerts don't count a
   * container stopped or restarted from the app as one that stopped by itself.
   */
  readonly requests$: Observable<ContainerActionRequest> = this.requested.asObservable();

  constructor(
    private readonly docker: DockerService,
    private readonly control: DockerControl,
    private readonly audit: AuditService,
  ) {}

  async act(action: ContainerAction, name: string, actor: ContainerActionActor): Promise<void> {
    const entry = (outcome: AuditEntry['outcome'], reason?: ContainerActionErrorCode) => ({
      action: `container.${action}` as const,
      outcome,
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { container: name, ...(reason && { reason }) },
    });

    if (PROTECTED_ACTIONS.includes(action)) {
      const refusal = await this.protectionCheck(name);
      if (refusal) {
        await this.audit.tryRecord(entry('failure', refusal));
        throw RESPONSES[refusal]();
      }
    }

    // Throws if it can't be written: then nothing happens.
    await this.audit.record(entry('requested'));
    this.requested.next({ action, name });

    try {
      await this.control[action](name);
    } catch (failure) {
      const code =
        failure instanceof ContainerActionError
          ? FAILURE_CODES[failure.reason]
          : CONTAINER_ACTION_ERROR_CODES.actionFailed;
      await this.audit.tryRecord(entry('failure', code));
      throw RESPONSES[code]();
    }
    await this.audit.tryRecord(entry('success'));
  }

  /** Why the container may not be interrupted, or null if it may. */
  private async protectionCheck(name: string): Promise<ContainerActionErrorCode | null> {
    let isProtected: boolean | null;
    try {
      isProtected = await this.docker.isProtected(name);
    } catch {
      return CONTAINER_ACTION_ERROR_CODES.dockerUnavailable;
    }
    if (isProtected === null) return CONTAINER_ACTION_ERROR_CODES.notFound;
    return isProtected ? CONTAINER_ACTION_ERROR_CODES.protected : null;
  }
}
