import { ChangesUnderway } from '../jobs/changes-underway.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { Sftp } from '../linux-sessions/sftp.js';
import { AppTasks, composeFacts, taskLines, taskResult } from './app-tasks.js';
import { TASK_TAIL_BYTES } from './apps.constants.js';

describe('a task’s log', () => {
  it('its result: the marker, then SERVICE_RESULT', () => {
    expect(taskResult('pulling\nstarted\n@@ilex-result\nsuccess\nexited\n0\n')).toEqual({
      succeeded: true,
    });
    expect(taskResult('…\n@@ilex-result\nexit-code\nexited\n1\n')).toEqual({ succeeded: false });
    expect(taskResult('still going\n')).toBeNull();
  });

  it('its lines: colours and carriage returns out, the result lines left out', () => {
    expect(taskLines('\u001b[32mStarted\u001b[0m\r\nok\n@@ilex-result\nsuccess\n')).toEqual([
      'Started',
      'ok',
    ]);
  });
});

describe('composeFacts', () => {
  it('bind mounts as folders; named volumes by Docker’s name, external and anonymous ones left out; the label', () => {
    expect(
      composeFacts(
        {
          mounts: [
            { type: 'bind', source: '/home/anna/apps/a/data' },
            { type: 'bind', source: '/home/anna/apps/a/data/' },
            { type: 'volume', source: null },
            { type: 'volume', source: 'db' },
            { type: 'volume', source: 'ext' },
            { type: 'volume', source: 'named' },
            { type: 'tmpfs', source: null },
          ],
          volumes: [
            { key: 'db', name: 'a_db', external: false },
            { key: 'ext', name: 'ext', external: true },
            { key: 'named', name: 'my-named', external: false },
          ],
          templates: ['not a label', 'immich@4'],
        },
        'a',
      ),
    ).toEqual({
      folders: ['/home/anna/apps/a/data'],
      volumes: ['a_db', 'my-named'],
      template: { id: 'immich', version: '4' },
    });
  });
});

describe('AppTasks.read', () => {
  const FOLDER = '/home/anna/apps/music';
  const record = {
    unit: 'ilex-app-music-up-1',
    system: false,
    action: 'up',
    log: '1-up.log',
    startedAt: '2026-10-28T12:00:00.000Z',
  };

  function reading(log: string, active: string | Record<string, unknown>) {
    const bytes = Buffer.from(log);
    const sftp = {
      readText: async () => JSON.stringify(record),
      statOrNull: async () => ({ size: bytes.length }),
      read: async (_path: string, length: number, position: number) =>
        bytes.subarray(position, position + length),
    } as unknown as Sftp;
    const linuxSessions = {
      account: () => ({ username: 'anna' }),
      ask: async () => (typeof active === 'string' ? { ok: true, active } : active),
    } as unknown as LinuxSessions;
    const tasks = new AppTasks(linuxSessions, new ChangesUnderway());
    return () => tasks.read('s1', sftp, FOLDER);
  }

  it('while it runs: whole lines only (the last may be half written)', async () => {
    const read = reading('pulling a\nPulling fo', 'active');
    expect(await read()).toMatchObject({ state: 'running', output: ['pulling a'] });
  });

  it('ended without a result: interrupted', async () => {
    const read = reading('pulling a\nfailed: no such image', 'failed');
    expect(await read()).toMatchObject({
      state: 'interrupted',
      output: ['pulling a', 'failed: no such image'],
    });
  });

  it('a task that ended between reading its log and asking systemd: its result, not interrupted', async () => {
    let log = Buffer.from('Extracting 15B\n');
    const sftp = {
      readText: async () => JSON.stringify(record),
      statOrNull: async () => ({ size: log.length }),
      read: async (_path: string, length: number, position: number) =>
        log.subarray(position, position + length),
    } as unknown as Sftp;
    const linuxSessions = {
      account: () => ({ username: 'anna' }),
      ask: async () => {
        // Meanwhile: done, its result written, the unit collected.
        log = Buffer.from('Extracting 15B\nStarted\n@@ilex-result\nsuccess\nexited\n0\n');
        return { ok: true, active: 'inactive' };
      },
    } as unknown as LinuxSessions;
    const tasks = new AppTasks(linuxSessions, new ChangesUnderway());
    expect(await tasks.read('s1', sftp, FOLDER)).toMatchObject({
      state: 'succeeded',
      output: ['Extracting 15B', 'Started'],
    });
  });

  it('a unit gone without a result (systemd: inactive): interrupted', async () => {
    const read = reading('pulling a\n', 'inactive');
    expect(await read()).toMatchObject({ state: 'interrupted', output: ['pulling a'] });
  });

  it.each([
    ['timed out', { ok: false, error: 'timed_out' }],
    ['the helper gone', { ok: false, error: 'ended' }],
    ['an empty answer (systemctl gave up on a busy machine)', ''],
    ['unknown', 'unknown'],
  ])('a state check that says nothing (%s): still running, not interrupted', async (_, answer) => {
    const read = reading('Extracting 14B\n', answer);
    expect(await read()).toMatchObject({ state: 'running', output: ['Extracting 14B'] });
  });

  it('a long log: its end (the reason it failed), from a line start, up to the result', async () => {
    const long = `${'x'.repeat(99)}\n`.repeat(TASK_TAIL_BYTES / 50);
    const read = reading(
      `${long}Error: pull access denied\n@@ilex-result\nexit-code\nexited\n1\n`,
      '',
    );
    const task = (await read())!;
    expect(task.state).toBe('failed');
    expect(task.output.at(-1)).toBe('Error: pull access denied');
    expect(task.output[0]).toBe('x'.repeat(99));
    expect(task.output.length).toBeLessThan(TASK_TAIL_BYTES / 100);
  });
});

describe('AppTasks.dockerAccess', () => {
  it('asked again for another account signed in within the minute', async () => {
    let username = 'anna';
    const groups: Record<string, boolean> = { anna: true, bob: false };
    const ask = vi.fn(async () => ({
      ok: true as const,
      userUnits: true,
      unitDocker: groups[username],
      loginDocker: groups[username],
    }));
    const linuxSessions = { account: () => ({ username }), ask } as unknown as LinuxSessions;
    const tasks = new AppTasks(linuxSessions, new ChangesUnderway());
    expect((await tasks.dockerAccess('s1')).quick).toBe('direct');
    expect((await tasks.dockerAccess('s1')).quick).toBe('direct');
    expect(ask).toHaveBeenCalledTimes(1);
    username = 'bob';
    expect(await tasks.dockerAccess('s1')).toMatchObject({ quick: 'sudo', system: true });
  });
});
