import type { Alert as AlertRow, AuditEvent, BackupRun } from '../generated/prisma/client.js';
import { fromAlert, fromAudit, fromBackupRun, mergeActivity } from './activity-items.js';

const at = new Date('2026-10-26T10:00:00Z');

function event(action: string, details: Record<string, unknown>, outcome = 'success'): AuditEvent {
  return {
    id: 'e1',
    at,
    userId: 'u1',
    username: 'owner',
    action,
    outcome: outcome as AuditEvent['outcome'],
    ip: '192.168.1.20',
    details: details as AuditEvent['details'],
  };
}

function subjectOf(e: AuditEvent): string | null | undefined {
  const item = fromAudit(e);
  return item?.source === 'action' ? item.subject : undefined;
}

describe('fromAudit', () => {
  it('shows the action, who, and the one allowed detail — nothing else', () => {
    const item = fromAudit(
      event('container.restart', { container: 'immich-server-1', reason: 'x', token: 'y' }),
    );
    expect(item).toEqual({
      source: 'action',
      id: 'e1',
      at: at.toISOString(),
      action: 'container.restart',
      username: 'owner',
      subject: 'immich-server-1',
    });
    expect(JSON.stringify(item)).not.toContain('192.168');
  });

  it('names an app by its name, a disk by its folder', () => {
    expect(subjectOf(event('app.install', { name: 'immich', folder: '/home/a/apps/immich' }))).toBe('immich');
    expect(subjectOf(event('app.remove', { name: 'Bad Name' }))).toBeNull();
    expect(subjectOf(event('disk.mount', { mountPoint: '/mnt/usb', uuid: 'abc' }))).toBe('/mnt/usb');
  });

  it('drops a detail that fails its check', () => {
    expect(subjectOf(event('disk.mount', { mountPoint: '/etc', uuid: 'abc' }))).toBeNull();
    expect(subjectOf(event('assistant.model_pull', { model: 'a b' }))).toBeNull();
    expect(subjectOf(event('container.stop', { container: 42 }))).toBeNull();
  });

  it('shows no detail for actions without one (a restore names no archive)', () => {
    expect(subjectOf(event('backup.restore', { itemId: 'i1', archive: 'a-2026' }))).toBeNull();
  });

  it('leaves out other actions and anything but successes', () => {
    expect(fromAudit(event('auth.login', {}))).toBeNull();
    expect(fromAudit(event('files.delete', { path: '/home/x' }))).toBeNull();
    expect(fromAudit(event('container.stop', { container: 'a' }, 'requested'))).toBeNull();
    expect(fromAudit(event('container.stop', { container: 'a' }, 'failure'))).toBeNull();
  });
});

describe('fromBackupRun', () => {
  const run = (status: BackupRun['status'], finishedAt: Date | null): BackupRun => ({
    id: 'r1',
    trigger: 'scheduled',
    itemId: null,
    status,
    errorCode: null,
    output: 'secret output',
    startedById: null,
    startedAt: at,
    finishedAt,
  });

  it('a finished run, when it finished — never its output', () => {
    const item = fromBackupRun(run('warning', at));
    expect(item).toEqual({
      source: 'backup',
      id: 'r1',
      at: at.toISOString(),
      trigger: 'scheduled',
      status: 'warning',
    });
  });

  it('nothing for a run still going', () => {
    expect(fromBackupRun(run('running', null))).toBeNull();
  });
});

describe('fromAlert', () => {
  const row = (closedAt: Date | null): AlertRow => ({
    id: 'a1',
    kind: 'serviceDown',
    subject: 'immich-server-1',
    severity: 'critical',
    details: { app: 'immich' },
    openedAt: at,
    closedAt,
    acknowledgedAt: null,
    acknowledgedById: null,
    acknowledgedBy: null,
    lastSentAt: null,
  });

  it('an open alert once, a closed one twice', () => {
    expect(fromAlert(row(null)).map((i) => i.id)).toEqual(['a1-opened']);
    const closed = fromAlert(row(new Date('2026-10-26T11:00:00Z')));
    expect(closed.map((i) => [i.id, i.at])).toEqual([
      ['a1-opened', at.toISOString()],
      ['a1-closed', '2026-10-26T11:00:00.000Z'],
    ]);
    expect(closed[0].source === 'alert' && closed[0].alert.app).toBe('immich');
  });
});

describe('mergeActivity', () => {
  it('newest first, at most the limit, without the left-out ones', () => {
    const item = (id: string, time: string) =>
      ({ source: 'backup', id, at: time, trigger: 'manual', status: 'ok' }) as const;
    expect(
      mergeActivity(
        [
          item('a', '2026-10-01T00:00:00.000Z'),
          null,
          item('b', '2026-10-03T00:00:00.000Z'),
          item('c', '2026-10-02T00:00:00.000Z'),
        ],
        2,
      ).map((i) => i.id),
    ).toEqual(['b', 'c']);
  });
});
