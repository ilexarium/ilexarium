import { Logger } from '@nestjs/common';
import type { ServerMessage, SystemSnapshot, SystemUpdate } from '@homelab/shared';
import { WebSocket } from 'ws';
import type { RealtimeClient } from './realtime-messages.js';
import { RealtimeSubscriptions, type TopicSource } from './realtime-subscriptions.js';

const update = { uptimeSeconds: 1 } as SystemUpdate;
const snapshot = { uptimeSeconds: 0 } as SystemSnapshot;

class FakeClient implements RealtimeClient {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  get events(): string[] {
    return this.sent.map((message) => message.event);
  }
}

class FakeSource implements TopicSource<'system'> {
  readonly topic = 'system';
  publish: ((update: SystemUpdate) => void) | null = null;
  starts = 0;
  stops = 0;
  snapshot = vi.fn(async (): Promise<SystemSnapshot> => snapshot);
  start(publish: (update: SystemUpdate) => void): void {
    this.starts++;
    this.publish = publish;
  }
  stop(): void {
    this.stops++;
    this.publish = null;
  }
  get collecting(): boolean {
    return this.publish !== null;
  }
}

describe('RealtimeSubscriptions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  let subscriptions: RealtimeSubscriptions;
  let source: FakeSource;

  beforeEach(() => {
    subscriptions = new RealtimeSubscriptions();
    source = new FakeSource();
    subscriptions.registerSource(source);
  });

  it('collects nothing until someone subscribes', () => {
    expect(source.starts).toBe(0);
    expect(source.snapshot).not.toHaveBeenCalled();
  });

  it('starts the source on the first subscriber and sends it the snapshot', async () => {
    const client = new FakeClient();
    await subscriptions.subscribe(client, 'system');
    expect(source.collecting).toBe(true);
    expect(client.sent).toEqual([{ event: 'system:snapshot', data: snapshot }]);
  });

  it('sends updates to every subscriber that has had its snapshot', async () => {
    const [a, b] = [new FakeClient(), new FakeClient()];
    await subscriptions.subscribe(a, 'system');
    await subscriptions.subscribe(b, 'system');
    source.publish!(update);
    expect(a.events).toEqual(['system:snapshot', 'system:update']);
    expect(b.events).toEqual(['system:snapshot', 'system:update']);
    expect(source.starts).toBe(1);
  });

  it('sends no update before the snapshot', async () => {
    let resolveSnapshot!: (value: SystemSnapshot) => void;
    source.snapshot.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );
    const client = new FakeClient();
    const subscribing = subscriptions.subscribe(client, 'system');
    source.publish!(update);
    resolveSnapshot(snapshot);
    await subscribing;
    source.publish!(update);
    expect(client.events).toEqual(['system:snapshot', 'system:update']);
  });

  it('ignores a repeated subscribe', async () => {
    const client = new FakeClient();
    await subscriptions.subscribe(client, 'system');
    await subscriptions.subscribe(client, 'system');
    expect(client.events).toEqual(['system:snapshot']);
    expect(subscriptions.subscriberCount('system')).toBe(1);
  });

  it('stops the source when the last subscriber leaves, and starts it again later', async () => {
    const [a, b] = [new FakeClient(), new FakeClient()];
    await subscriptions.subscribe(a, 'system');
    await subscriptions.subscribe(b, 'system');
    subscriptions.unsubscribe(a, 'system');
    expect(source.collecting).toBe(true);
    subscriptions.removeClient(b);
    expect(source.collecting).toBe(false);
    expect(source.stops).toBe(1);

    await subscriptions.subscribe(a, 'system');
    expect(source.starts).toBe(2);
  });

  it('ignores unsubscribing when not subscribed', () => {
    subscriptions.unsubscribe(new FakeClient(), 'system');
    expect(source.stops).toBe(0);
  });

  it('does not send the snapshot to a client that left while it was being taken', async () => {
    let resolveSnapshot!: (value: SystemSnapshot) => void;
    source.snapshot.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );
    const client = new FakeClient();
    const subscribing = subscriptions.subscribe(client, 'system');
    subscriptions.unsubscribe(client, 'system');
    resolveSnapshot(snapshot);
    await subscribing;
    expect(client.sent).toEqual([]);
    expect(source.collecting).toBe(false);
  });

  it('keeps the subscription when the snapshot fails, and sends updates', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    source.snapshot.mockRejectedValueOnce(new Error('boom'));
    const client = new FakeClient();
    await expect(subscriptions.subscribe(client, 'system')).resolves.toBeUndefined();
    source.publish!(update);
    expect(client.events).toEqual(['system:update']);
  });

  it('skips closed and backed-up clients', async () => {
    const [closed, slow] = [new FakeClient(), new FakeClient()];
    await subscriptions.subscribe(closed, 'system');
    await subscriptions.subscribe(slow, 'system');
    closed.readyState = WebSocket.CLOSING;
    slow.bufferedAmount = 2 * 1024 * 1024;
    source.publish!(update);
    expect(closed.events).toEqual(['system:snapshot']);
    expect(slow.events).toEqual(['system:snapshot']);
  });

  it('accepts subscriptions to a topic without a source', async () => {
    const client = new FakeClient();
    await subscriptions.subscribe(client, 'containers');
    expect(client.sent).toEqual([]);
    expect(subscriptions.subscriberCount('containers')).toBe(1);
  });

  it('refuses a second source for the same topic', () => {
    expect(() => subscriptions.registerSource(new FakeSource())).toThrow(/already registered/);
  });

  it('stops running sources on shutdown', async () => {
    await subscriptions.subscribe(new FakeClient(), 'system');
    subscriptions.onModuleDestroy();
    expect(source.collecting).toBe(false);
  });
});
