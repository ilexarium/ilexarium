import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AppTask, BackupsStatus } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { testStarted, testTask } from '../../../core/apps/testing';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { NewAppPageStore } from './new-app-page-store';

const COMPOSE =
  "services:\n  web:\n    image: navidrome/navidrome:${VERSION:-0.53}\n    ports: ['${PORT}:4533']\n";

const backupsStatus: BackupsStatus = {
  configured: true,
  warnings: [],
  lastSuccessAt: null,
  nextRunAt: null,
  running: null,
  lastRun: null,
  items: [],
  restore: null,
  lastCheck: null,
};

async function setup() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const answers: (AppTask | null)[] = [];
  const appsApi = {
    templates: vi.fn(() => of([])),
    template: vi.fn(() =>
      of({
        template: { id: 'navidrome', version: '2', backup: { mode: 'live', skip: ['cache'] } },
        compose: COMPOSE,
      }),
    ),
    // The server's guess: PORT and a new secret are filled in, VERSION from the file's default.
    fields: vi.fn(() =>
      of({
        fields: [
          { key: 'VERSION', kind: 'version', value: '0.53', default: '0.53', required: false },
          { key: 'PORT', kind: 'port', value: '4533', default: null, required: true },
        ],
        images: [],
        problem: null,
      }),
    ),
    checkName: vi.fn((name: string) => of({ free: false, suggestion: `${name}-2` })),
    install: vi.fn(() => of(testStarted('navidrome-2'))),
    task: vi.fn(() => of({ task: answers.shift() ?? null })),
  };
  const backupsApi = { addItem: vi.fn(() => of({})) };
  const asPerson = vi.fn(<T>(action: () => Promise<T>) => action());
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: AppsApi, useValue: appsApi },
      { provide: BackupsApi, useValue: backupsApi },
      { provide: LinuxSessionStore, useValue: { asPerson, check: vi.fn() } },
      NewAppPageStore,
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  TestBed.inject(BackupsStore).watch();
  const store = TestBed.inject(NewAppPageStore);
  return { store, appsApi, backupsApi, asPerson, answers, socket };
}

describe('NewAppPageStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a template: its file, its form with the values written to .env, a free name, its backup preset', async () => {
    const { store, appsApi } = await setup();
    await store.chooseTemplate('navidrome');
    await vi.waitFor(() => expect(store.fields()).not.toBeNull());
    expect(store.step()).toBe('setup');
    expect(store.compose()).toBe(COMPOSE);
    expect(appsApi.fields).toHaveBeenCalledWith({
      compose: COMPOSE,
      env: '',
      template: 'navidrome',
    });
    expect(store.env()).toBe('VERSION=0.53\nPORT=4533\n');
    expect(store.name()).toBe('navidrome-2');
    expect(store.backup()).toEqual({ include: true, mode: 'live', skip: ['cache'] });
  });

  it('a pasted file: its own name suggested, a field’s kind changed by the person', async () => {
    const { store, appsApi } = await setup();
    await store.usePasted(`name: music\n${COMPOSE}`);
    await vi.waitFor(() => expect(store.fields()).not.toBeNull());
    expect(appsApi.checkName).toHaveBeenCalledWith('music');
    expect(store.template()).toBeNull();
    store.setKind('PORT', 'text');
    expect(store.shownFields().map((f) => [f.key, f.kind])).toEqual([
      ['VERSION', 'version'],
      ['PORT', 'text'],
    ]);
  });

  it('installs as the person, follows the output, then adds the app to the backups', async () => {
    const { store, appsApi, backupsApi, answers, socket } = await setup();
    socket.receive({ event: 'backups:snapshot', data: backupsStatus });
    expect(store.backupsConfigured()).toBe(true);
    await store.chooseTemplate('navidrome');
    await vi.waitFor(() => expect(store.fields()).not.toBeNull());
    answers.push(testTask({ output: ['pulling'], next: 8 }));
    answers.push(testTask({ state: 'succeeded', output: ['started'], next: 16 }));
    await store.install();
    expect(appsApi.install).toHaveBeenCalledWith({
      name: 'navidrome-2',
      folder: null,
      template: 'navidrome',
      compose: COMPOSE,
      env: 'VERSION=0.53\nPORT=4533\n',
    });
    expect(store.step()).toBe('installing');
    await vi.waitFor(() => expect(store.installed()).not.toBeNull(), { timeout: 4000 });
    expect(store.lines()).toEqual(['pulling', 'started']);
    expect(backupsApi.addItem).toHaveBeenCalledWith({
      kind: 'app',
      project: 'navidrome-2',
      folders: [],
      skip: ['/home/anna/apps/navidrome-2/cache'],
      mode: 'live',
    });
  });

  it('shows what Compose said when it refused the files, staying on the form', async () => {
    const { store, appsApi } = await setup();
    const error = vi.spyOn(toast, 'error');
    await store.usePasted(COMPOSE);
    appsApi.install.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 422,
            error: { message: 'x', code: 'compose_invalid', detail: 'services.web: bad port' },
          }),
      ),
    );
    await store.install();
    expect(store.problem()).toBe('services.web: bad port');
    expect(store.step()).toBe('setup');
    expect(error).toHaveBeenCalled();
  });
});
