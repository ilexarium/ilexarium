import { APP_QUIET_MS } from './jobs.constants.js';
import { ChangesUnderway } from './changes-underway.js';

describe('ChangesUnderway', () => {
  afterEach(() => vi.useRealTimers());

  it('knows when any app is being changed: a task a little while ago, or a backup', () => {
    vi.useFakeTimers();
    const changes = new ChangesUnderway();
    expect(changes.anyApp()).toBe(false);
    changes.appTask('music');
    expect(changes.anyApp()).toBe(true);
    expect(changes.app('photos')).toBe(false);
    vi.advanceTimersByTime(APP_QUIET_MS + 1);
    expect(changes.anyApp()).toBe(false);

    let backingUp = true;
    changes.follow(() => backingUp);
    expect(changes.anyApp()).toBe(true);
    backingUp = false;
    expect(changes.anyApp()).toBe(false);
  });
});
