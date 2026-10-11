import type { AddressInfo } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { REALTIME_PATH } from '@homelab/shared';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SystemMetricsService } from '../src/system-metrics/system-metrics.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { Client } from './realtime-client.js';

const PASSWORD = 'correct horse battery';
const testHasher = new PasswordHasher({ logN: 11 });

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
    await app.listen(0, '127.0.0.1');
    const host = `127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    await resetDatabase(app.get(PrismaService));
    await app.get(UsersService).create({
      username: 'owner',
      passwordHash: await testHasher.hash(PASSWORD),
    });
    const login = await request(`http://${host}`)
      .post('/api/auth/login')
      .set('Origin', `http://${host}`)
      .send({ username: 'owner', password: PASSWORD })
      .expect(200);
    const cookie = ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('__Host-sid='))!
      .split(';')[0];
    client = new Client(
      new WebSocket(`ws://${host}${REALTIME_PATH}`, {
        headers: { Cookie: cookie },
        origin: `http://${host}`,
      }),
    );
    await new Promise((resolve) => client.socket.once('open', resolve));
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
