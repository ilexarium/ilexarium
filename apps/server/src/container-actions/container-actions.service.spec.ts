import type { PublicUser } from '@homelab/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { AuditEntry } from '../audit/audit.model.js';
import { ContainerActionError, type DockerControl } from '../docker/docker-control.js';
import type { DockerService } from '../docker/docker.service.js';
import { ContainerActionsService } from './container-actions.service.js';

const USER: PublicUser = {
  id: 'u1',
  username: 'owner',
  createdAt: '2026-10-12T00:00:00.000Z',
  displayName: null,
  email: null,
  language: null,
  avatar: null,
};
const ACTOR = { user: USER, ip: '127.0.0.1' };

/** Everything in call order: audit entries and Docker calls, so the order can be checked. */
function setup({ protectedNames = ['postgres'], known = ['jellyfin', 'postgres'] } = {}) {
  const calls: string[] = [];
  const entries: AuditEntry[] = [];
  const docker = {
    isProtected: vi.fn(async (name: string) =>
      known.includes(name) ? protectedNames.includes(name) : null,
    ),
  };
  const act = (action: string) =>
    vi.fn(async (name: string) => {
      calls.push(`docker ${action} ${name}`);
    });
  const control = { start: act('start'), stop: act('stop'), restart: act('restart') };
  const record = (entry: AuditEntry) => {
    calls.push(`audit ${entry.outcome}`);
    entries.push(entry);
  };
  const audit = {
    record: vi.fn(async (entry: AuditEntry) => record(entry)),
    tryRecord: vi.fn(async (entry: AuditEntry) => record(entry)),
  };
  const service = new ContainerActionsService(
    docker as unknown as DockerService,
    control as unknown as DockerControl,
    audit as unknown as AuditService,
  );
  return { service, docker, control, audit, calls, entries };
}

describe('ContainerActionsService', () => {
  it('records the request (failing closed), acts, then records the outcome', async () => {
    const { service, audit, calls, entries } = setup();
    await service.act('stop', 'jellyfin', ACTOR);
    expect(calls).toEqual(['audit requested', 'docker stop jellyfin', 'audit success']);
    // The request goes through record() — the one that rejects when it can't write.
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0].outcome).toBe('requested');
    expect(entries[0]).toEqual({
      action: 'container.stop',
      outcome: 'requested',
      userId: 'u1',
      username: 'owner',
      ip: '127.0.0.1',
      details: { container: 'jellyfin' },
    });
    expect(entries[1]).toMatchObject({ action: 'container.stop', outcome: 'success' });
  });

  it('does not touch Docker when the request cannot be recorded', async () => {
    const { service, audit, control } = setup();
    audit.record.mockRejectedValueOnce(new Error('database down'));
    await expect(service.act('restart', 'jellyfin', ACTOR)).rejects.toThrow('database down');
    expect(control.restart).not.toHaveBeenCalled();
    expect(audit.tryRecord).not.toHaveBeenCalled();
  });

  it.each(['stop', 'restart'] as const)('refuses to %s a protected container', async (action) => {
    const { service, control, calls, entries } = setup();
    await expect(service.act(action, 'postgres', ACTOR)).rejects.toMatchObject({
      status: 403,
      response: { code: 'container_protected' },
    });
    expect(control[action]).not.toHaveBeenCalled();
    expect(calls).toEqual(['audit failure']);
    expect(entries[0]).toMatchObject({
      action: `container.${action}`,
      details: { container: 'postgres', reason: 'container_protected' },
    });
  });

  it('starts a protected container (nothing is interrupted) without asking about labels', async () => {
    const { service, docker, calls } = setup();
    await service.act('start', 'postgres', ACTOR);
    expect(docker.isProtected).not.toHaveBeenCalled();
    expect(calls).toEqual(['audit requested', 'docker start postgres', 'audit success']);
  });

  it('answers 404 for an unknown container before recording a request', async () => {
    const { service, control, calls } = setup();
    await expect(service.act('stop', 'nope', ACTOR)).rejects.toMatchObject({
      status: 404,
      response: { code: 'container_not_found' },
    });
    expect(control.stop).not.toHaveBeenCalled();
    expect(calls).toEqual(['audit failure']);
  });

  it('answers 503 when Docker cannot be asked about protection', async () => {
    const { service, docker, control } = setup();
    docker.isProtected.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(service.act('stop', 'jellyfin', ACTOR)).rejects.toMatchObject({
      status: 503,
      response: { code: 'docker_unavailable' },
    });
    expect(control.stop).not.toHaveBeenCalled();
  });

  it.each([
    [new ContainerActionError('not_found'), 404, 'container_not_found'],
    [new ContainerActionError('failed'), 502, 'action_failed'],
    [new ContainerActionError('unavailable'), 503, 'docker_unavailable'],
    [new Error('unexpected'), 502, 'action_failed'],
  ])('records a failed action and answers with its code (%s)', async (failure, status, code) => {
    const { service, control, calls, entries } = setup();
    control.start.mockRejectedValueOnce(failure);
    await expect(service.act('start', 'jellyfin', ACTOR)).rejects.toMatchObject({
      status,
      response: { code },
    });
    expect(calls).toEqual(['audit requested', 'audit failure']);
    expect(entries[1]).toMatchObject({
      action: 'container.start',
      outcome: 'failure',
      details: { container: 'jellyfin', reason: code },
    });
  });
});
