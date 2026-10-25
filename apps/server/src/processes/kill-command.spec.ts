import type { ProcessSignal } from '@laris/shared';
import { killCommand } from './kill-command.js';

describe('killCommand: the one command line ending a process', () => {
  it('is the fixed template: the signal and the PID, nothing else', () => {
    expect(killCommand(4312, 'TERM', false)).toBe('env LC_ALL=C kill -s TERM -- 4312');
    expect(killCommand(4312, 'KILL', false)).toBe('env LC_ALL=C kill -s KILL -- 4312');
  });

  it('as administrator: sudo asks every time, reads the password from stdin, no prompt', () => {
    expect(killCommand(77, 'TERM', true)).toBe(
      "env LC_ALL=C sudo -k -S -p '' -- kill -s TERM -- 77",
    );
  });

  it.each([0, -1, 1.5, Number.NaN, 4_194_305, Number.MAX_SAFE_INTEGER + 2])(
    'refuses %s as a PID',
    (pid) => {
      expect(() => killCommand(pid, 'TERM', false)).toThrow();
    },
  );

  it.each(['HUP', 'TERM; reboot', '$(id)', '', 'term'])('refuses %j as a signal', (signal) => {
    expect(() => killCommand(4312, signal as ProcessSignal, false)).toThrow();
  });

  it('refuses a PID smuggled in as text', () => {
    expect(() => killCommand('1; reboot' as unknown as number, 'TERM', false)).toThrow();
  });
});
