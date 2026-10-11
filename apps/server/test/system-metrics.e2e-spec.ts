import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { SystemMetricsService } from '../src/system-metrics/system-metrics.service.js';
import { type Client, connectSignedIn, testHasher } from './realtime-client.js';

// The real `system` topic on this machine, end to end: the gateway, the subscription registry,
// SystemMetricsService and SystemReader. Every message is checked against the shared schema.
describe('system topic (e2e)', () => {
  let app: NestExpressApplication;
  let client: Client;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    client = await connectSignedIn(app);
  });

  afterEach(async () => {
    client.socket.terminate();
    await app.close();
  });

  it('sends a snapshot of this machine, then live updates, and stops when unsubscribed', async () => {
    const metrics = app.get(SystemMetricsService);
    expect(metrics.collecting).toBe(false);

    client.send({ event: 'subscribe', data: { topic: 'system' } });
    const [snapshot] = await client.received(1);
    expect(snapshot.event).toBe('system:snapshot');
    if (snapshot.event !== 'system:snapshot') return;
    expect(snapshot.data.host.cpuCores).toBeGreaterThan(0);
    expect(snapshot.data.disks.map((disk) => disk.mount)).toContain('/');
    expect(snapshot.data.history).toHaveLength(1);

    const [, update] = await client.received(2, 4000); // one sample interval (2 s) later
    expect(update.event).toBe('system:update');

    client.send({ event: 'unsubscribe', data: { topic: 'system' } });
    await vi.waitFor(() => expect(metrics.collecting).toBe(false));
  });
});
