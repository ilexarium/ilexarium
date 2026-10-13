import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { InstalledService } from '@homelab/shared';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { RealtimeService } from '../realtime/realtime-service';
import { fakeSockets } from '../realtime/testing';
import { ServicesStore } from './services-store';

const service: InstalledService = {
  id: '0193a000-0000-7000-8000-0000000000aa',
  catalogId: 'immich',
  name: 'Immich',
  status: 'installed',
  settings: { WEB_PORT: 2283 },
  webPort: 2283,
  job: null,
  updatedAt: '2026-10-12T10:00:00.000Z',
};

async function setup() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: 'login', children: [] }]), auth.provider, sockets.provider],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  sockets.latest().open();
  const store = TestBed.inject(ServicesStore);
  TestBed.tick();
  return { store, socket: sockets.latest() };
}

describe('ServicesStore', () => {
  it('follows the services topic while watched', async () => {
    const { store, socket } = await setup();
    const stop = store.watch();
    expect(socket.sent).toEqual([{ event: 'subscribe', data: { topic: 'services' } }]);
    socket.receive({ event: 'services:snapshot', data: { services: [service] } });
    expect(store.services()).toEqual([service]);
    socket.receive({ event: 'services:update', data: { services: [] } });
    expect(store.services()).toEqual([]);
    stop();
    expect(socket.sent.at(-1)).toEqual({ event: 'unsubscribe', data: { topic: 'services' } });
  });

  it('is reset on sign-out: nothing of the previous user stays', async () => {
    const { store, socket } = await setup();
    store.watch();
    socket.receive({ event: 'services:snapshot', data: { services: [service] } });
    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    expect(store.services()).toBeNull();
  });
});
