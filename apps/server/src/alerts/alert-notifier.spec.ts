import { Subject } from 'rxjs';
import type { AlertChannels } from './alert-channels.js';
import { AlertNotifier } from './alert-notifier.js';
import { HOUR_MS, REMINDER_CHECK_MS, RETRY_AFTER_MS } from './alerts.constants.js';
import type { AlertRecords } from './alert-records.js';
import type { AlertEvent, AlertMessage, ChannelConfig, OpenAlert } from './alerts.model.js';

const NTFY: ChannelConfig = { kind: 'ntfy', topicUrl: 'https://ntfy.sh/t', token: null };
const EMAIL: ChannelConfig = {
  kind: 'email',
  host: 'mail.example.com',
  port: 587,
  username: 'alerts',
  password: 'secret',
  from: 'ilex@example.com',
  to: 'me@example.com',
};

function alert(subject: string, overrides: Partial<OpenAlert> = {}): OpenAlert {
  return {
    id: `id-${subject}`,
    kind: 'serviceDown',
    subject,
    severity: 'critical',
    details: { app: subject },
    openedAt: new Date(),
    acknowledgedAt: null,
    lastSentAt: null,
    ...overrides,
  };
}

describe('AlertNotifier', () => {
  let events: Subject<AlertEvent>;
  let sent: AlertMessage[];
  let marked: string[];
  let enabled: ChannelConfig[];
  let failNext: number;
  /** Channels that can't be reached: every message to them fails. */
  let down: Set<ChannelConfig['kind']>;
  /** Every try, delivered or not, by channel. */
  let tries: ChannelConfig['kind'][];
  /** While set, a channel answers only once it resolves. */
  let answerAfter: Promise<void> | null;
  /** Channels that take every message but answer too late: they count as timed out. */
  let late: Set<ChannelConfig['kind']>;
  /** When each message arrived at a channel, delivered or timed out. */
  let arrivedAt: number[];
  /** Messages whose title matches are refused, whatever the channel. */
  let refuse: RegExp | null;
  let reminders: OpenAlert[];
  let notifier: AlertNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    events = new Subject();
    sent = [];
    marked = [];
    enabled = [NTFY];
    failNext = 0;
    down = new Set();
    tries = [];
    answerAfter = null;
    late = new Set();
    arrivedAt = [];
    refuse = null;
    reminders = [];
    const records = {
      events$: events.asObservable(),
      markSent: async (id: string) => void marked.push(id),
      dueReminders: async () => reminders.filter((a) => !marked.includes(a.id)),
      open: async () => reminders,
    } as unknown as AlertRecords;
    const channels = {
      enabled: async () => enabled,
      sendTo: async (config: ChannelConfig, message: AlertMessage) => {
        tries.push(config.kind);
        await answerAfter;
        if (down.has(config.kind)) return 'unreachable';
        if (refuse?.test(message.title)) return 'rejected';
        arrivedAt.push(Date.now());
        if (late.has(config.kind)) {
          sent.push(message);
          return 'timedOut';
        }
        if (failNext > 0) {
          failNext--;
          return 'unreachable';
        }
        sent.push(message);
        return null;
      },
    } as unknown as AlertChannels;
    notifier = new AlertNotifier(records, channels);
    notifier.onModuleInit();
  });

  afterEach(() => {
    notifier.onModuleDestroy();
    vi.useRealTimers();
  });

  const settle = () => vi.advanceTimersByTimeAsync(0);

  it('sends one message when an alert opens and one when it closes', async () => {
    events.next({ type: 'opened', alert: alert('immich') });
    await settle();
    events.next({ type: 'closed', alert: alert('immich') });
    await settle();
    expect(sent.map((m) => [m.title, m.severity])).toEqual([
      ['immich has stopped', 'critical'],
      ['Resolved: immich has stopped', 'resolved'],
    ]);
    expect(marked).toEqual(['id-immich']);
  });

  it('says what and where, never more', async () => {
    events.next({ type: 'opened', alert: alert('immich') });
    await settle();
    expect(sent[0].body).toMatch(/^On .+, since \d{4}-\d\d-\d\d \d\d:\d\d\. Container: immich\./);
  });

  it('no message for an out-of-memory alert closing (a one-off event)', async () => {
    events.next({ type: 'closed', alert: alert('immich', { kind: 'outOfMemory' }) });
    await settle();
    expect(sent).toEqual([]);
  });

  it('with no channel switched on, nothing is sent or marked', async () => {
    enabled = [];
    events.next({ type: 'opened', alert: alert('immich') });
    await settle();
    expect(sent).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('sends at most 10 messages an hour; the rest go as one when the hour allows', async () => {
    for (let i = 0; i < 13; i++) {
      events.next({ type: 'opened', alert: alert(`svc-${i}`) });
      await settle();
    }
    expect(sent).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(sent).toHaveLength(11);
    expect(sent[10].title).toBe('3 more alert messages');
    expect(sent[10].body).toContain('- svc-10 has stopped');
    expect(sent[10].body).toContain('- svc-12 has stopped');
    expect(sent[10].severity).toBe('critical');
  });

  it('counts a held message as sent only once it has gone out', async () => {
    for (let i = 0; i < 11; i++) {
      events.next({ type: 'opened', alert: alert(`svc-${i}`) });
      await settle();
    }
    expect(marked).not.toContain('id-svc-10');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(marked).toContain('id-svc-10');
  });

  it('drops held messages if every channel is switched off meanwhile, not marking them sent', async () => {
    for (let i = 0; i < 11; i++) {
      events.next({ type: 'opened', alert: alert(`svc-${i}`) });
      await settle();
    }
    enabled = [];
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(sent).toHaveLength(10);
    expect(marked).not.toContain('id-svc-10');
  });

  it('doesn’t remind of an alert whose message is still held', async () => {
    for (let i = 0; i < 11; i++) {
      events.next({ type: 'opened', alert: alert(`svc-${i}`) });
      await settle();
    }
    reminders = [alert('svc-10')];
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS);
    // Not held a second time: when the hour allows, only its own message goes.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(sent.slice(10).map((m) => m.title)).toEqual(['svc-10 has stopped']);
  });

  it('tries a failed delivery once more after a minute; the alert counts as sent only then', async () => {
    failNext = 1;
    events.next({ type: 'opened', alert: alert('immich') });
    await settle();
    expect(sent).toEqual([]);
    expect(marked).toEqual([]);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(sent.map((m) => m.title)).toEqual(['immich has stopped']);
    expect(marked).toEqual(['id-immich']);
  });

  it('doesn’t count an alert as sent when every channel failed; the reminder round sends it once they work', async () => {
    enabled = [NTFY, EMAIL];
    down = new Set(['ntfy', 'email']);
    events.next({
      type: 'opened',
      alert: alert('immich', { kind: 'unhealthy', severity: 'warning' }),
    });
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(tries).toEqual(['ntfy', 'email', 'ntfy', 'email']); // the retry failed too
    expect(marked).toEqual([]);

    down.clear();
    reminders = [alert('immich', { kind: 'unhealthy', severity: 'warning' })];
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS);
    expect(sent).toEqual([]); // 10 minutes after its last try: not yet
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS);
    // Its opening message, the one never delivered — not a reminder.
    expect(sent.map((m) => [m.title, m.severity])).toEqual([
      ['immich is unhealthy', 'warning'],
      ['immich is unhealthy', 'warning'],
    ]);
    expect(marked).toEqual(['id-immich']);
  });

  it('counts a message as sent when one channel delivered it and another failed', async () => {
    enabled = [NTFY, EMAIL];
    down = new Set(['email']);
    events.next({ type: 'opened', alert: alert('immich') });
    await settle();
    expect(sent.map((m) => m.title)).toEqual(['immich has stopped']);
    expect(marked).toEqual(['id-immich']);
    // The failed channel is still tried once more.
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(tries).toEqual(['ntfy', 'email', 'email']);
  });

  it('counts a held message as sent only once it reaches a channel, if need be by its retry', async () => {
    for (let i = 0; i < 11; i++) {
      events.next({ type: 'opened', alert: alert(`svc-${i}`) });
      await settle();
    }
    failNext = 1;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(marked).not.toContain('id-svc-10');
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(sent.map((m) => m.title).at(-1)).toBe('svc-10 has stopped');
    expect(marked).toContain('id-svc-10');
  });

  it('with no channel switched on, the reminder round tries nothing', async () => {
    enabled = [];
    reminders = [alert('immich'), alert('jellyfin', { severity: 'warning' })];
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS * 6);
    expect(tries).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('while the channels fail, a reminder round tries one message, not every one', async () => {
    down = new Set(['ntfy']);
    reminders = ['a', 'b', 'c', 'd', 'e'].map((name) => alert(name));
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS * 3 + RETRY_AFTER_MS);
    // Three rounds: one message each, and its retry a minute later.
    expect(tries).toHaveLength(6);
    expect(marked).toEqual([]);
  });

  it('failed messages don’t use up the hour’s 10: when the network is back, they go, 10 an hour', async () => {
    down = new Set(['ntfy']);
    for (let i = 0; i < 10; i++) {
      events.next({ type: 'opened', alert: alert(`svc-${i}`) });
      await settle();
    }
    reminders = Array.from({ length: 10 }, (_, i) => alert(`svc-${i}`));
    // Rounds at 20 and 30 minutes try svc-0 and svc-1 once more; both fail.
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS * 3 + RETRY_AFTER_MS);
    expect(sent).toEqual([]);

    down.clear();
    events.next({ type: 'opened', alert: alert('new') });
    await settle();
    expect(sent.map((m) => m.title)).toEqual(['new has stopped']);
    // At 40 minutes svc-2 to svc-9; at 50 svc-0 (its gap is 30 minutes now): 10 in the hour.
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS * 2);
    expect(sent).toHaveLength(10);
    // svc-1 is due at 60 minutes but the hour's 10 are used: held until the hour allows.
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS);
    expect(sent).toHaveLength(10);
    expect(marked).not.toContain('id-svc-1');
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(sent).toHaveLength(11);
    expect(sent[10].title).toBe('svc-1 has stopped');
    expect(marked).toContain('id-svc-1');
  });

  it('a channel that takes messages but answers too late gets an alert’s message after a growing gap, at most every 4 hours', async () => {
    late = new Set(['ntfy']);
    events.next({ type: 'opened', alert: alert('immich') });
    await settle();
    reminders = [alert('immich')];
    // Tried at 0, 20 min, 50 min, 1 h 50, 3 h 50, then every 4 hours; never again a minute later.
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS);
    expect(sent).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS);
    expect(sent).toHaveLength(16);
    expect(marked).toEqual([]);
  });

  it('the receiving side gets at most 10 an hour, even from a channel that answers too late', async () => {
    late = new Set(['ntfy']);
    reminders = Array.from({ length: 25 }, (_, i) => alert(`svc-${i}`));
    for (const each of reminders) {
      events.next({ type: 'opened', alert: each });
      await settle();
    }
    await vi.advanceTimersByTimeAsync(12 * HOUR_MS);
    const mostInAnHour = Math.max(
      ...arrivedAt.map((at) => arrivedAt.filter((t) => t >= at && t < at + HOUR_MS).length),
    );
    expect(mostInAnHour).toBe(10);
    expect(arrivedAt.length).toBeGreaterThan(30);
  });

  it('one message no channel takes doesn’t hold up the others in the reminder round', async () => {
    refuse = /stuck/;
    reminders = [
      alert('stuck'),
      alert('jellyfin', { kind: 'unhealthy', severity: 'warning' }),
      alert('immich', { lastSentAt: new Date(Date.now() - 86_400_000) }),
    ];
    // Round 1 tries the stuck one first and ends; round 2 starts with those not tried yet.
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS * 2);
    expect(sent.map((m) => m.title)).toEqual([
      'jellyfin is unhealthy',
      'Still: immich has stopped',
    ]);
    expect(marked).toEqual(['id-jellyfin', 'id-immich']);
  });

  it('the gap starts again after a message got through', async () => {
    down = new Set(['ntfy']);
    reminders = [alert('immich', { lastSentAt: new Date(Date.now() - 86_400_000) })];
    // Tried at 10, 30 and 60 minutes (each with its retry a minute later), all failing.
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(tries).toHaveLength(6);
    down.clear();
    // Next due 60 minutes after the last try.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sent.map((m) => m.title)).toEqual(['Still: immich has stopped']);

    // A day later its reminder fails again: tried at once, then after 15 minutes (not 2 hours),
    // each with its retry.
    tries = [];
    marked = [];
    down = new Set(['ntfy']);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(tries).toEqual(['ntfy', 'ntfy', 'ntfy', 'ntfy']);
  });

  it('tries nothing more after shutdown, even for a message whose delivery was under way', async () => {
    let answer = () => {};
    answerAfter = new Promise((resolve) => (answer = resolve));
    down = new Set(['ntfy']);
    events.next({ type: 'opened', alert: alert('immich') });
    await settle();
    notifier.onModuleDestroy();
    answer();
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(tries).toEqual(['ntfy']);
  });

  it('reminds of critical alerts once a day until acknowledged', async () => {
    reminders = [alert('immich', { lastSentAt: new Date(Date.now() - 86_400_000) })];
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS);
    expect(sent.map((m) => m.title)).toEqual(['Still: immich has stopped']);
    expect(marked).toEqual(['id-immich']);
  });
});
