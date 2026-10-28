import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Container } from '@laris/shared';
import { of } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { ContainersApi } from '../../../core/containers/containers-api';
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
  protected: false,
  composeProject: null,
  composeWorkingDir: null,
  template: null,
  stats: null,
};

async function render() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const api = { act: vi.fn(() => of(null)) };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: ContainersApi, useValue: api },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const fixture = TestBed.createComponent(ContainersPage);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, socket, api };
}

describe('ContainersPage', () => {
  it('subscribes to the containers topic only, until it is left', async () => {
    const { fixture, socket } = await render();
    expect(socket.sent).toEqual([{ event: 'subscribe', data: { topic: 'containers' } }]);
    fixture.destroy();
    expect(socket.sent.at(-1)).toEqual({ event: 'unsubscribe', data: { topic: 'containers' } });
  });

  it('runs the action chosen in the table through the actions store', async () => {
    const { fixture, el, socket, api } = await render();
    socket.receive({
      event: 'containers:snapshot',
      data: { dockerAvailable: true, containers: [stopped], history: {} },
    });
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('button[aria-label="Actions for old-app"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
    const start = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent!.trim() === 'Start',
    )!;
    start.click();
    await vi.waitFor(() => expect(api.act).toHaveBeenCalledWith('old-app', 'start'));
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
      // Phones get cards (the table is hidden below xl), each with the actions button.
      const card = el.querySelector('ul.xl\\:hidden > li')!;
      expect(card.querySelector('button[aria-label="Actions for old-app"]')).not.toBeNull();
    } finally {
      restore();
    }
  });
});
