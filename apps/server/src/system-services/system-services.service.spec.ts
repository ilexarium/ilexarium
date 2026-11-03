import type { LinuxSession, PublicUser } from '@laris/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { HelperAnswer } from '../linux-sessions/linux-sessions.model.js';
import { SystemServicesService } from './system-services.service.js';

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
const SESSION = 'app-session';

const properties = (overrides: Record<string, string> = {}) => ({
  Id: 'nginx.service',
  Names: 'nginx.service',
  Description: 'A web server',
  LoadState: 'loaded',
  ActiveState: 'active',
  SubState: 'running',
  UnitFileState: 'enabled',
  FragmentPath: '/usr/lib/systemd/system/nginx.service',
  MainPID: '452',
  MemoryCurrent: '16023552',
  Result: 'success',
  ExecMainStatus: '0',
  NRestarts: '0',
  StateChangeTimestamp: '@1792573340',
  ...overrides,
});

describe('SystemServicesService', () => {
  let linux: LinuxSession | null;
  let answers: Record<string, HelperAnswer>;
  let ask: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;
  let tryRecord: ReturnType<typeof vi.fn>;
  let service: SystemServicesService;

  beforeEach(() => {
    linux = { username: 'anna', home: '/home/anna', uid: 1500, sudoUntil: null };
    answers = {
      'units.show': { ok: true, properties: properties() },
      'units.control': { ok: true },
    };
    ask = vi.fn(async (_session: string, request: { action: string }) => answers[request.action]);
    record = vi.fn(async () => undefined);
    tryRecord = vi.fn(async () => undefined);
    service = new SystemServicesService(
      { current: () => linux, ask } as unknown as LinuxSessions,
      { record, tryRecord } as unknown as AuditService,
    );
  });

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { getStatus(): number; getResponse(): { code: string } }) => [
        error.getStatus(),
        error.getResponse().code,
      ],
    );
  const act = (name = 'nginx.service', action: 'start' | 'stop' | 'restart' = 'restart') =>
    service.act(SESSION, name, action, ACTOR);

  it('lists the units as the account, each with its protection', async () => {
    answers['units.list'] = {
      ok: true,
      truncated: false,
      units: [
        {
          unit: 'vpn.service',
          load: 'loaded',
          active: 'failed',
          sub: 'failed',
          description: 'VPN',
          enabled: null,
        },
        {
          unit: 'laris.service',
          load: 'loaded',
          active: 'active',
          sub: 'running',
          description: 'Laris',
          enabled: 'enabled',
        },
        {
          unit: 'ssh.service',
          load: 'loaded',
          active: 'active',
          sub: 'running',
          description: 'SSH',
          enabled: 'enabled',
        },
      ],
    };
    const { services, truncated } = await service.list(SESSION);
    expect(truncated).toBe(false);
    expect(services.map((s) => [s.name, s.protection])).toEqual([
      ['vpn.service', null],
      ['laris.service', 'laris'],
      ['ssh.service', 'essential'],
    ]);
    expect(services[0]).toMatchObject({ active: 'failed', sub: 'failed', description: 'VPN' });
    expect(ask).toHaveBeenCalledWith(SESSION, { action: 'units.list' }, expect.anything());
  });

  it('a list systemctl couldn’t give, or an answer of another shape: unavailable', async () => {
    answers['units.list'] = { ok: false, error: 'failed' };
    expect(await rejection(service.list(SESSION))).toEqual([503, 'services_unavailable']);
    answers['units.list'] = { ok: true, units: 'nope' };
    expect(await rejection(service.list(SESSION))).toEqual([503, 'services_unavailable']);
    answers['units.list'] = { ok: false, error: 'ended' };
    expect(await rejection(service.list(SESSION))).toEqual([503, 'helper_unavailable']);
  });

  it('turns a unit’s properties into its details; systemd’s “not set” stays empty', async () => {
    expect(await service.details(SESSION, 'nginx.service')).toEqual({
      name: 'nginx.service',
      description: 'A web server',
      load: 'loaded',
      active: 'active',
      sub: 'running',
      enabled: 'enabled',
      protection: null,
      since: '2026-10-21T09:02:20.000Z',
      mainPid: 452,
      memoryBytes: 16023552,
      result: 'success',
      exitStatus: 0,
      restarts: 0,
      unitFile: '/usr/lib/systemd/system/nginx.service',
    });
    answers['units.show'] = {
      ok: true,
      properties: properties({
        MainPID: '0',
        MemoryCurrent: '[not set]',
        StateChangeTimestamp: '',
        UnitFileState: '',
        FragmentPath: '',
      }),
    };
    expect(await service.details(SESSION, 'nginx.service')).toMatchObject({
      mainPid: null,
      memoryBytes: null,
      since: null,
      enabled: null,
      unitFile: null,
    });
    answers['units.show'] = {
      ok: true,
      properties: properties({ MemoryCurrent: '18446744073709551615' }),
    };
    expect((await service.details(SESSION, 'nginx.service')).memoryBytes).toBeNull();
  });

  it('a unit systemd doesn’t know: not found', async () => {
    answers['units.show'] = {
      ok: true,
      properties: properties({ LoadState: 'not-found', ActiveState: 'inactive' }),
    };
    expect(await rejection(service.details(SESSION, 'nope.service'))).toEqual([
      404,
      'service_not_found',
    ]);
  });

  it('a unit whose file is gone but still runs: shown, and can be stopped', async () => {
    answers['units.show'] = {
      ok: true,
      properties: properties({ LoadState: 'not-found', FragmentPath: '' }),
    };
    expect(await service.details(SESSION, 'nginx.service')).toMatchObject({
      load: 'not-found',
      active: 'active',
    });
    await act('nginx.service', 'stop');
    expect(tryRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('restarts a unit through sudo by its own name, recorded first', async () => {
    answers['units.show'] = {
      ok: true,
      properties: properties({ Id: 'nginx.service', Names: 'nginx.service web.service' }),
    };
    await act('web.service');
    expect(ask).toHaveBeenLastCalledWith(
      SESSION,
      { action: 'units.control', unit: 'nginx.service', command: 'restart' },
      { sudo: true, timeoutMs: expect.any(Number) },
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'system_service.restart',
        outcome: 'requested',
        details: { unit: 'nginx.service', linuxUser: 'anna' },
      }),
    );
    expect(tryRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(ask.mock.invocationCallOrder.at(-1)!);
  });

  it('Laris’s own units: nothing; those it needs: never stopped — an alias protects too', async () => {
    answers['units.show'] = { ok: true, properties: properties({ Id: 'laris.service' }) };
    for (const action of ['start', 'stop', 'restart'] as const) {
      expect(await rejection(act('laris.service', action))).toEqual([403, 'service_protected']);
    }
    answers['units.show'] = {
      ok: true,
      properties: properties({ Id: 'ssh.service', Names: 'ssh.service sshd.service' }),
    };
    expect(await rejection(act('sshd.service', 'stop'))).toEqual([403, 'service_protected']);
    expect(record).not.toHaveBeenCalled();
    await act('sshd.service', 'restart');
    expect(ask).toHaveBeenLastCalledWith(
      SESSION,
      { action: 'units.control', unit: 'ssh.service', command: 'restart' },
      expect.anything(),
    );
  });

  it('without the audit log, nothing changes', async () => {
    record.mockRejectedValueOnce(new Error('db down'));
    expect(await rejection(act())).toEqual([503, 'audit_unavailable']);
    expect(ask).not.toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ action: 'units.control' }),
      expect.anything(),
    );
  });

  it('says what went wrong — sudo locked, systemd refused, still going — and records it', async () => {
    for (const [error, expected] of [
      ['sudo_required', [403, 'sudo_required']],
      ['failed', [502, 'service_action_failed']],
      ['timed_out', [504, 'service_timed_out']],
      ['ended', [503, 'helper_unavailable']],
    ] as const) {
      answers['units.control'] = { ok: false, error, message: 'Job failed' };
      expect(await rejection(act()), error).toEqual(expected);
      expect(tryRecord).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outcome: 'failure',
          details: expect.objectContaining({ reason: expected[1] }),
        }),
      );
    }
  });

  it('needs a Linux session', async () => {
    linux = null;
    expect(await rejection(act())).toEqual([403, 'linux_session_required']);
    expect(ask).not.toHaveBeenCalled();
  });
});
