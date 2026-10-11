import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Container } from '@homelab/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { stubScreenWidth } from '../../../layout/testing';
import { ContainersPage } from './containers-page';

const stopped: Container = {
  id: 'b2',
  name: 'old-app',
  image: 'old/app:1',
  state: 'exited',
  health: 'none',
  startedAt: null,
  ports: [],
  stats: null,
};

async function render() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  TestBed.configureTestingModule({
    providers: [provideRouter([]), auth.provider, sockets.provider],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const fixture = TestBed.createComponent(ContainersPage);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, socket };
}

describe('ContainersPage', () => {
  it('subscribes to the containers topic only, until it is left', async () => {
    const { fixture, socket } = await render();
    expect(socket.sent).toEqual([{ event: 'subscribe', data: { topic: 'containers' } }]);
    fixture.destroy();
    expect(socket.sent.at(-1)).toEqual({ event: 'unsubscribe', data: { topic: 'containers' } });
  });

  it('shows a loading state, then every container — stopped ones too — with its actions', async () => {
    const { fixture, el, socket } = await render();
    expect(el.querySelector('[role="status"]')!.getAttribute('aria-label')).toBe(
      'Loading containers',
    );
    socket.receive({
      event: 'containers:snapshot',
      data: { dockerAvailable: true, containers: [stopped], history: {} },
    });
    await fixture.whenStable();
    expect(el.querySelector('tbody')!.textContent).toContain('old-app');
    expect(el.querySelector('tbody')!.textContent).toContain('Stopped');
    expect(el.querySelector('button[aria-label="Actions for old-app"]')).not.toBeNull();
  });

  it('has no heading of its own (the top bar shows the title) and no sideways scrolling on phones', async () => {
    const restore = stubScreenWidth(375);
    try {
      const { fixture, el, socket } = await render();
      socket.receive({
        event: 'containers:snapshot',
        data: { dockerAvailable: true, containers: [stopped], history: {} },
      });
      await fixture.whenStable();
      expect(el.querySelector('h1')).toBeNull();
      // Phones get cards (the table is hidden below lg), each with the actions button.
      const card = el.querySelector('ul.lg\\:hidden > li')!;
      expect(card.querySelector('button[aria-label="Actions for old-app"]')).not.toBeNull();
    } finally {
      restore();
    }
  });
});
