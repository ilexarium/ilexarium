import { Subject } from 'rxjs';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { AlertChannels } from './alert-channels.js';
import { AlertNotifier } from './alert-notifier.js';
import { REMINDER_CHECK_MS, RETRY_AFTER_MS } from './alerts.constants.js';
import type { AlertRecords } from './alert-records.js';
import type { AlertEvent, AlertMessage, ChannelConfig, OpenAlert } from './alerts.model.js';

const NTFY: ChannelConfig = { kind: 'ntfy', topicUrl: 'https://ntfy.sh/t', token: null };

function alert(subject: string, overrides: Partial<OpenAlert> = {}): OpenAlert {
  return {
    id: `id-${subject}`,
    kind: 'serviceDown',
    subject,
    severity: 'critical',
    details: { catalogId: subject },
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
  let reminders: OpenAlert[];
  let notifier: AlertNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    events = new Subject();
    sent = [];
    marked = [];
    enabled = [NTFY];
    failNext = 0;
    reminders = [];
    const records = {
      events$: events.asObservable(),
      markSent: async (id: string) => void marked.push(id),
      dueReminders: async () => reminders.filter((a) => !marked.includes(a.id)),
    } as unknown as AlertRecords;
    const channels = {
      enabled: async () => enabled,
      sendTo: async (_config: ChannelConfig, message: AlertMessage) => {
        if (failNext > 0) {
          failNext--;
          return 'unreachable';
        }
        sent.push(message);
        return null;
      },
    } as unknown as AlertChannels;
    const catalog = {
      get: (id: string) => (id === 'immich' ? { meta: { name: 'Immich' } } : undefined),
    } as unknown as CatalogService;
    notifier = new AlertNotifier(records, channels, catalog);
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
      ['Immich has stopped', 'critical'],
      ['Resolved: Immich has stopped', 'resolved'],
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

  it('tries a failed delivery once more after a minute, then leaves it', async () => {
    failNext = 2;
    events.next({ type: 'opened', alert: alert('immich') });
    await settle();
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(sent).toEqual([]); // the retry failed too
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS * 5);
    expect(sent).toEqual([]);

    failNext = 1;
    events.next({ type: 'opened', alert: alert('other') });
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(sent.map((m) => m.title)).toEqual(['other has stopped']);
  });

  it('reminds of critical alerts once a day until acknowledged', async () => {
    reminders = [alert('immich', { lastSentAt: new Date(Date.now() - 86_400_000) })];
    await vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS);
    expect(sent.map((m) => m.title)).toEqual(['Still: Immich has stopped']);
    expect(marked).toEqual(['id-immich']);
  });
});
