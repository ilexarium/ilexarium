import { ChangesUnderway } from '../jobs/changes-underway.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { AppSftp } from './app-sftp.js';
import { AppTasks, taskLines, taskResult } from './app-tasks.js';
import { TASK_READ_BYTES } from './apps.constants.js';

describe('a task’s log', () => {
  it('its result: the marker, then SERVICE_RESULT', () => {
    expect(taskResult('pulling\nstarted\n@@laris-result\nsuccess\nexited\n0\n')).toEqual({
      succeeded: true,
    });
    expect(taskResult('…\n@@laris-result\nexit-code\nexited\n1\n')).toEqual({ succeeded: false });
    expect(taskResult('still going\n')).toBeNull();
  });

  it('its lines: colours and carriage returns out, the result lines left out', () => {
    expect(taskLines('\u001b[32mStarted\u001b[0m\r\nok\n@@laris-result\nsuccess\n')).toEqual([
      'Started',
      'ok',
    ]);
  });
});

describe('AppTasks.read', () => {
  const FOLDER = '/home/anna/apps/music';
  const record = {
    unit: 'laris-app-music-up-1',
    system: false,
    action: 'up',
    log: '1-up.log',
    startedAt: '2026-10-28T12:00:00.000Z',
  };

  function reading(log: string, active: string) {
    const bytes = Buffer.from(log);
    const sftp = {
      readText: async () => JSON.stringify(record),
      stat: async () => ({ size: bytes.length }),
      read: async (_path: string, length: number, position: number) =>
        bytes.subarray(position, position + length),
    } as unknown as AppSftp;
    const linuxSessions = {
      account: () => ({ username: 'anna' }),
      ask: async () => ({ ok: true, active }),
    } as unknown as LinuxSessions;
    const tasks = new AppTasks(linuxSessions, new ChangesUnderway());
    return (from = 0) => tasks.read('s1', sftp, FOLDER, from);
  }

  it('while it runs: whole lines only, the next read from the line cut off', async () => {
    const read = reading('pulling a\nPulling fo', 'active');
    const task = await read();
    expect(task).toMatchObject({ state: 'running', output: ['pulling a'], next: 10 });
  });

  it('finished: its last line too, even without a line break', async () => {
    const read = reading('pulling a\nfailed: no such image', 'failed');
    expect(await read()).toMatchObject({
      state: 'interrupted',
      output: ['pulling a', 'failed: no such image'],
    });
  });

  it('a long finished log: its end (the reason it failed), from a line start', async () => {
    const long = `${'x'.repeat(99)}\n`.repeat(TASK_READ_BYTES / 50);
    const read = reading(
      `${long}Error: pull access denied\n@@laris-result\nexit-code\nexited\n1\n`,
      '',
    );
    const task = (await read())!;
    expect(task.state).toBe('failed');
    expect(task.output.at(-1)).toBe('Error: pull access denied');
    expect(task.output[0]).toBe('x'.repeat(99));
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
