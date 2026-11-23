import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Container } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { type Observable, of } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { testApp, testContainer, testStarted, testTask } from '../../../core/apps/testing';
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

async function render(withoutContainers = [testApp('notes', { state: 'none', containers: [] })]) {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const appsApi = {
    templates: vi.fn(() => of([])),
    // Signed in to Linux: an app in ~/apps that doesn't run.
    list: vi.fn(() => of({ apps: withoutContainers })),
    start: vi.fn((name: string) => of(testStarted(name))),
    task: vi.fn((_name: string) => of({ task: testTask({ action: 'up', state: 'succeeded' }) })),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: AppsApi, useValue: appsApi },
      {
        provide: LinuxSessionStore,
        useValue: {
          check: vi.fn(),
          session: () => null,
          asPerson$: <T>(action: () => Observable<T>) => action(),
        },
      },
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
  return { el, socket, receive, appsApi, fixture };
}

describe('AppsPage', () => {
  afterEach(() => vi.restoreAllMocks());

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
          container('ilex-postgres-1', { composeProject: 'ilex', protected: true }),
          container('loose'),
        ],
        history: {},
      },
    });
    const cards = [...el.querySelectorAll('ilex-app-card')].map((c) => c.textContent!);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('music');
    expect(cards[1]).toContain('notes');
  });

  it('says how the apps are doing: all running, some, or which need attention', async () => {
    const { el, receive } = await render();
    const headline = () => el.querySelector('p[role="status"]')!.textContent!.trim();
    const music = (change: Partial<Container> = {}) =>
      testContainer('music-web-1', 'music', change);
    const send = (...containers: Container[]) =>
      receive({
        event: 'containers:snapshot',
        data: { dockerAvailable: true, containers, history: {} },
      });
    // `notes` rests in ~/apps (no containers): not running.
    await send(music());
    expect(headline()).toBe('1 of 2 apps is running');
    await send(music({ state: 'restarting' }));
    expect(headline()).toBe('One app needs your attention');
    await send(music({ health: 'unhealthy' }));
    expect(headline()).toBe('One app needs your attention');
  });

  it('says so when every app runs', async () => {
    const { el, receive } = await render([]);
    await receive({
      event: 'containers:snapshot',
      data: {
        dockerAvailable: true,
        containers: [testContainer('music-web-1', 'music'), testContainer('notes-web-1', 'notes')],
        history: {},
      },
    });
    expect(el.querySelector('p[role="status"]')!.textContent!.trim()).toBe(
      'All 2 apps are running',
    );
  });

  it('cards: live CPU and memory, the last backup, whose and where; a dashed tile to add one', async () => {
    const { el, receive } = await render();
    await receive({
      event: 'containers:snapshot',
      data: {
        dockerAvailable: true,
        containers: [testContainer('music-web-1', 'music'), testContainer('music-db-1', 'music')],
        history: {},
      },
    });
    const card = el.querySelector('ilex-app-card')!;
    expect(card.textContent).toContain('4%');
    expect(card.textContent).toContain('100 MB');
    expect(card.textContent).toContain('Not backed up');
    expect(card.textContent).toContain('~/apps/music');
    const tile = el.querySelector<HTMLAnchorElement>('a[data-add-tile]')!;
    expect(tile.getAttribute('href')).toBe('/apps/new');
    expect(tile.className).toContain('border-dashed');
  });

  it('an app without containers: Start runs up from its folder, as the person, and follows it', async () => {
    const { el, receive, appsApi, fixture } = await render();
    await receive({
      event: 'containers:snapshot',
      data: { dockerAvailable: true, containers: [], history: {} },
    });
    const start = el.querySelector<HTMLButtonElement>('button[aria-label="Start notes"]')!;
    expect(start).not.toBeNull();
    start.click();
    await vi.waitFor(() => expect(appsApi.task).toHaveBeenCalled());
    expect(appsApi.start).toHaveBeenCalledWith('notes', '/home/anna/apps/notes');
    await vi.waitFor(() => expect(appsApi.list).toHaveBeenCalledTimes(2));
    await fixture.whenStable();
    expect(start.disabled).toBe(false);
  });

  it('the card stays busy while its start runs, then is free again', async () => {
    const { el, receive, appsApi, fixture } = await render();
    let state: 'running' | 'succeeded' = 'running';
    appsApi.task.mockImplementation(() => of({ task: testTask({ action: 'up', state }) }));
    await receive({
      event: 'containers:snapshot',
      data: { dockerAvailable: true, containers: [], history: {} },
    });
    const start = el.querySelector<HTMLButtonElement>('button[aria-label="Start notes"]')!;
    start.click();
    await vi.waitFor(() => expect(appsApi.task).toHaveBeenCalled());
    await fixture.whenStable();
    expect(start.disabled).toBe(true);
    state = 'succeeded';
    await vi.waitFor(() => expect(appsApi.list).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await fixture.whenStable();
    expect(start.disabled).toBe(false);
  });

  it('two cards started side by side: each followed, each said how it ended', async () => {
    const { el, receive, appsApi, fixture } = await render([
      testApp('notes', { state: 'none', containers: [] }),
      testApp('wiki', { state: 'none', containers: [] }),
    ]);
    const states: Record<string, 'running' | 'succeeded' | 'failed'> = {
      notes: 'running',
      wiki: 'running',
    };
    appsApi.task.mockImplementation((name: string) =>
      of({ task: testTask({ action: 'up', state: states[name] }) }),
    );
    const success = vi.spyOn(toast, 'success');
    const error = vi.spyOn(toast, 'error');
    await receive({
      event: 'containers:snapshot',
      data: { dockerAvailable: true, containers: [], history: {} },
    });
    const button = (name: string) =>
      el.querySelector<HTMLButtonElement>(`button[aria-label="Start ${name}"]`)!;
    button('notes').click();
    button('wiki').click();
    await vi.waitFor(() => expect(appsApi.task).toHaveBeenCalledWith('wiki', expect.any(String)));
    await fixture.whenStable();
    expect(button('notes').disabled).toBe(true);
    expect(button('wiki').disabled).toBe(true);
    states['wiki'] = 'failed';
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Couldn't start wiki"), {
      timeout: 4000,
    });
    await fixture.whenStable();
    expect(button('wiki').disabled).toBe(false);
    expect(button('notes').disabled).toBe(true);
    states['notes'] = 'succeeded';
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('notes started'), {
      timeout: 4000,
    });
    await fixture.whenStable();
    expect(button('notes').disabled).toBe(false);
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
