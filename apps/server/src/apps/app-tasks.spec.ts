import { taskLines, taskResult } from './app-tasks.js';

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
