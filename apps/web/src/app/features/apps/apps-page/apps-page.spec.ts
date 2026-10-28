import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Container } from '@laris/shared';
import { of } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { testApp } from '../../../core/apps/testing';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { AppsPage } from './apps-page';

const container = (name: string, change: Partial<Container> = {}): Container => ({
  id: name,
  name,
  image: 'example/x:1',
  state: 'running',
  health: 'none',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: null,
  composeWorkingDir: null,
  template: null,
  stats: null,
  ...change,
});

async function render() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const appsApi = {
    templates: vi.fn(() => of([])),
    // Signed in to Linux: an app in ~/apps that doesn't run.
    list: vi.fn(() => of({ apps: [testApp('notes', { state: 'none', containers: [] })] })),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: AppsApi, useValue: appsApi },
      { provide: LinuxSessionStore, useValue: { check: vi.fn(), session: () => null } },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const fixture = TestBed.createComponent(AppsPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const receive = async (message: unknown) => {
    socket.receive(message);
    await fixture.whenStable();
  };
  return { el, socket, receive };
}

describe('AppsPage', () => {
  it('waits for the containers, then lists each Compose project — the platform’s own and loose containers left out', async () => {
    const { el, socket, receive } = await render();
    expect(socket.sent).toContainEqual({ event: 'subscribe', data: { topic: 'containers' } });
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    await receive({
      event: 'containers:snapshot',
      data: {
        dockerAvailable: true,
        containers: [
          container('music-web-1', {
            composeProject: 'music',
            composeWorkingDir: '/home/anna/apps/music',
          }),
          container('laris-postgres-1', { composeProject: 'laris', protected: true }),
          container('loose'),
        ],
        history: {},
      },
    });
    const cards = [...el.querySelectorAll('laris-app-card')].map((c) => c.textContent!);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('music');
    expect(cards[1]).toContain('notes');
  });

  it('Docker down: said so; adding an app still offered', async () => {
    const { el, receive } = await render();
    await receive({
      event: 'containers:snapshot',
      data: { dockerAvailable: false, containers: [], history: {} },
    });
    expect(el.querySelector('[role="alert"]')!.textContent).toContain("Docker can't be reached");
    expect(el.querySelector('a[href="/apps/new"]')).not.toBeNull();
  });
});
