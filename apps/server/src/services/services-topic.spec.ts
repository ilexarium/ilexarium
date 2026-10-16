import { Subject } from 'rxjs';
import type { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import { SERVICES_PUBLISH_MS, ServicesTopic } from './services-topic.js';
import type { ServiceJobs } from './service-jobs.js';
import type { ServiceManager } from './service-manager.js';

describe('ServicesTopic', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const changes = new Subject<void>();
    const services = { list: vi.fn(async () => []) };
    const jobs = { changes$: changes };
    const subscriptions = { registerSource: vi.fn() };
    const topic = new ServicesTopic(
      services as unknown as ServiceManager,
      jobs as unknown as ServiceJobs,
      subscriptions as unknown as RealtimeSubscriptions,
    );
    return { topic, services, subscriptions, change: () => changes.next() };
  }

  it('registers itself as the services topic', () => {
    const { topic, subscriptions } = setup();
    expect(subscriptions.registerSource).toHaveBeenCalledWith(topic);
    expect(topic.topic).toBe('services');
  });

  it('publishes a burst of changes (every output line) as one update', async () => {
    const { topic, services, change } = setup();
    const publish = vi.fn();
    topic.updates$.subscribe(publish);
    for (let i = 0; i < 20; i++) change();
    await vi.advanceTimersByTimeAsync(SERVICES_PUBLISH_MS);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({ services: [] });
    expect(services.list).toHaveBeenCalledTimes(1);
  });

  it('stops listening when unsubscribed, leaving no timers', async () => {
    const { topic, change } = setup();
    const publish = vi.fn();
    const subscription = topic.updates$.subscribe(publish);
    change();
    subscription.unsubscribe();
    change();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SERVICES_PUBLISH_MS * 2);
    expect(publish).not.toHaveBeenCalled();
  });
});
