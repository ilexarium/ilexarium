import type { LinuxSession } from '@ilex/shared';
import type { SystemReader } from '../host/system-reader.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { linuxError, linuxSessionRequired } from '../linux-sessions/linux-session-errors.js';
import type { HelperAnswer } from '../linux-sessions/linux-sessions.model.js';
import { MachineCheckService } from './machine-check.service.js';

const SESSION = 'app-session';

describe('MachineCheckService', () => {
  let linux: LinuxSession | null;
  let answers: Record<string, HelperAnswer | Error>;
  let ask: ReturnType<typeof vi.fn>;
  let lingering: ReturnType<typeof vi.fn>;
  let service: MachineCheckService;

  beforeEach(() => {
    linux = { username: 'anna', home: '/home/anna', uid: 1500, sudoUntil: null };
    answers = {
      hello: { ok: true, uid: 1500, gid: 1500, user: 'anna', home: '/home/anna' },
      'docker.access': { ok: true, userUnits: true, unitDocker: true, loginDocker: true },
    };
    ask = vi.fn(async (_session: string, request: { action: string }) => {
      if (!linux) throw linuxSessionRequired();
      const answer = answers[request.action];
      if (answer instanceof Error) throw answer;
      return answer;
    });
    lingering = vi.fn(async () => true);
    service = new MachineCheckService(
      { current: () => linux, ask } as unknown as LinuxSessions,
      { lingering } as unknown as SystemReader,
    );
  });

  it('asks the helper who it is, then how apps reach Docker: every step passed', async () => {
    expect(await service.person(SESSION)).toEqual({
      helper: 'ok',
      userUnits: true,
      lingering: true,
      docker: 'user_units',
    });
    expect(lingering).toHaveBeenCalledWith('anna');
    expect(ask.mock.calls.map(([session, request]) => [session, request])).toEqual([
      [SESSION, { action: 'hello' }],
      [SESSION, { action: 'docker.access' }],
    ]);
  });

  it('without the docker group in user units: system units through sudo; in the group but started before: a restart', async () => {
    answers['docker.access'] = { ok: true, userUnits: true, unitDocker: false, loginDocker: false };
    expect(await service.person(SESSION)).toMatchObject({
      userUnits: true,
      docker: 'system_units',
    });
    answers['docker.access'] = { ok: true, userUnits: true, unitDocker: false, loginDocker: true };
    expect(await service.person(SESSION)).toMatchObject({ docker: 'restart_needed' });
  });

  it('no user units: they fail, and apps run as system units until they start (the docker group is no fix)', async () => {
    answers['docker.access'] = { ok: true, userUnits: false, unitDocker: false, loginDocker: true };
    expect(await service.person(SESSION)).toEqual({
      helper: 'ok',
      userUnits: false,
      lingering: true,
      docker: 'no_user_units',
    });
  });

  it('user units start in the session, but lingering is off: said apart', async () => {
    lingering.mockResolvedValue(false);
    expect(await service.person(SESSION)).toMatchObject({ userUnits: true, lingering: false });
  });

  it('a helper that didn’t start, doesn’t answer, or runs as someone else: the later steps aren’t checked', async () => {
    const notChecked = { userUnits: null, lingering: null, docker: null };
    answers['hello'] = linuxError('helper_unavailable', 'no helper');
    expect(await service.person(SESSION)).toEqual({ helper: 'unavailable', ...notChecked });
    answers['hello'] = { ok: false, error: 'timed_out' };
    expect(await service.person(SESSION)).toEqual({ helper: 'unavailable', ...notChecked });
    answers['hello'] = { ok: true, uid: 0, user: 'root' };
    expect(await service.person(SESSION)).toEqual({ helper: 'wrong_account', ...notChecked });
    answers['hello'] = { ok: true, uid: 1500, user: 'anna' };
    answers['docker.access'] = { ok: false, error: 'ended' };
    expect(await service.person(SESSION)).toEqual({ helper: 'unavailable', ...notChecked });
  });

  it('without a Linux session: 403 linux_session_required', async () => {
    linux = null;
    await expect(service.person(SESSION)).rejects.toMatchObject({
      status: 403,
      response: { code: 'linux_session_required' },
    });
  });
});
