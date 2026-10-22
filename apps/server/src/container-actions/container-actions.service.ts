import { HttpException, Injectable } from '@nestjs/common';
import {
  type ApiErrorResponse,
  CONTAINER_ACTION_ERROR_CODES,
  type ContainerAction,
  type ContainerActionErrorCode,
  type ContainerActionParams,
  PROTECTED_ACTIONS,
} from '@laris/shared';
import { type Observable, Subject } from 'rxjs';
import { AuditService } from '../audit/audit.service.js';
import type { AuditEntry } from '../audit/audit.model.js';
import { ContainerActionError, DockerControl } from '../docker/docker-control.js';
import { DockerService } from '../docker/docker.service.js';
import { ERRORS, FAILURE_CODES } from './container-actions.constants.js';
import type { ContainerActionActor } from './container-actions.model.js';

function refusal(code: ContainerActionErrorCode): HttpException {
  const [status, message] = ERRORS[code];
  const body: ApiErrorResponse = { message, code };
  return new HttpException(body, status);
}

/**
 * The order every privileged action follows: check (protected containers can't be stopped or
 * restarted), **record the request — or don't act** (fail closed), act, record the outcome.
 */
@Injectable()
export class ContainerActionsService {
  private readonly requested = new Subject<ContainerActionParams>();

  /**
   * An action is about to happen (recorded, not yet done) — so the health alerts don't count a
   * container stopped or restarted from the app as one that stopped by itself.
   */
  readonly requests$: Observable<ContainerActionParams> = this.requested.asObservable();

  constructor(
    private readonly dockerService: DockerService,
    private readonly dockerControl: DockerControl,
    private readonly auditService: AuditService,
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
      const refused = await this.protectionCheck(name);
      if (refused) {
        await this.auditService.tryRecord(entry('failure', refused));
        throw refusal(refused);
      }
    }

    // Throws if it can't be written: then nothing happens.
    await this.auditService.record(entry('requested'));
    this.requested.next({ action, name });

    try {
      await this.dockerControl[action](name);
    } catch (failure) {
      const code =
        failure instanceof ContainerActionError
          ? FAILURE_CODES[failure.reason]
          : CONTAINER_ACTION_ERROR_CODES.actionFailed;
      await this.auditService.tryRecord(entry('failure', code));
      throw refusal(code);
    }
    await this.auditService.tryRecord(entry('success'));
  }

  /** Why the container may not be interrupted, or null if it may. */
  private async protectionCheck(name: string): Promise<ContainerActionErrorCode | null> {
    let isProtected: boolean | null;
    try {
      isProtected = await this.dockerService.isProtected(name);
    } catch {
      return CONTAINER_ACTION_ERROR_CODES.dockerUnavailable;
    }
    if (isProtected === null) return CONTAINER_ACTION_ERROR_CODES.notFound;
    return isProtected ? CONTAINER_ACTION_ERROR_CODES.protected : null;
  }
}
