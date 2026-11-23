import { HttpErrorResponse } from '@angular/common/http';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AppField, AppStarted, AppTask, BackupsStatus, TemplateSummary } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { testStarted, testTask, testTemplate } from '../../../core/apps/testing';
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

async function setup(templates: TemplateSummary[] = []) {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const answers: (AppTask | null)[] = [];
  const appsApi = {
    templates: vi.fn(() => of(templates)),
    template: vi.fn(() =>
      of({
        template: { id: 'navidrome', version: '2', backup: { mode: 'live', skip: ['cache'] } },
        compose: COMPOSE,
      }),
    ),
    // The template's form, its defaults filled in.
    fields: vi.fn(() =>
      of({
        fields: [
          { key: 'VERSION', kind: 'version', value: '0.53', default: '0.53', required: false },
          { key: 'PORT', kind: 'port', value: '4533', default: '4533', required: false },
        ],
      }),
    ),
    checkName: vi.fn((name: string) => of({ free: false, suggestion: `${name}-2` })),
    install: vi.fn((): Observable<AppStarted> => of(testStarted('navidrome-2'))),
    task: vi.fn(() => of({ task: answers.shift() ?? null })),
  };
  const backupsApi = { addItem: vi.fn(() => of({})) };
  const asPerson = vi.fn(<T>(action: () => Observable<T>): Observable<T | null> => action());
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: AppsApi, useValue: appsApi },
      { provide: BackupsApi, useValue: backupsApi },
      { provide: LinuxSessionStore, useValue: { asPerson$: asPerson, check: vi.fn() } },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  TestBed.inject(BackupsStore).watch();
  // Its own injector, like a page's: destroying it is leaving the page.
  const page = createEnvironmentInjector([NewAppPageStore], TestBed.inject(EnvironmentInjector));
  const store = page.get(NewAppPageStore);
  return { store, page, appsApi, backupsApi, asPerson, answers, socket };
}

describe('NewAppPageStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a template: its file, its form with the values written to .env, a free name', async () => {
    const { store, appsApi } = await setup();
    await store.chooseTemplate('navidrome');
    await vi.waitFor(() => expect(store.fields()).not.toBeNull());
    expect(store.step()).toBe('setup');
    expect(store.compose()).toBe(COMPOSE);
    expect(appsApi.fields).toHaveBeenCalledWith({ template: 'navidrome' });
    expect(store.env()).toBe('VERSION=0.53\nPORT=4533\n');
    expect(store.name()).toBe('navidrome-2');
  });

  it('your own file: its own name suggested once pasted, no form — its files as they are', async () => {
    const { store, appsApi } = await setup();
    await store.useOwnFile();
    expect(store.step()).toBe('setup');
    expect(appsApi.checkName).toHaveBeenCalledWith('app');
    store.setCompose(`name: music\n${COMPOSE}`);
    await vi.waitFor(() => expect(store.name()).toBe('music-2'));
    expect(appsApi.checkName).toHaveBeenCalledWith('music');
    // Taken (music-2 now): an edit to the file doesn't ask for it again.
    appsApi.checkName.mockClear();
    store.setCompose(`name: music\n${COMPOSE}# more\n`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(appsApi.checkName).not.toHaveBeenCalled();
    expect(store.template()).toBeNull();
    store.setEnv('PORT=80\n');
    expect(store.fields()).toBeNull();
    expect(appsApi.fields).not.toHaveBeenCalled();
    expect(store.env()).toBe('PORT=80\n');
    expect(store.canInstall()).toBe(true);
  });

  it('your own file: a name typed by hand stays; nothing to install without a file', async () => {
    const { store, appsApi } = await setup();
    await store.useOwnFile();
    expect(store.canInstall()).toBe(false);
    store.setName('songs');
    appsApi.checkName.mockClear();
    store.setCompose(`name: music\n${COMPOSE}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(appsApi.checkName).not.toHaveBeenCalledWith('music');
    expect(store.name()).toBe('songs');
  });

  it('a suggestion answered after a name was typed: the typed name stays', async () => {
    const { store, appsApi } = await setup();
    await store.useOwnFile();
    const late = new Subject<{ free: boolean; suggestion: string }>();
    appsApi.checkName.mockReturnValueOnce(late as never);
    store.setCompose(`name: notes\n${COMPOSE}`);
    await vi.waitFor(() => expect(appsApi.checkName).toHaveBeenCalledWith('notes'));
    store.setName('blog');
    late.next({ free: true, suggestion: 'notes' });
    late.complete();
    await new Promise((resolve) => setTimeout(resolve));
    expect(store.name()).toBe('blog');
  });

  it('searches the templates by name and description, every word typed; Back keeps the search', async () => {
    const { store } = await setup([
      testTemplate('immich', { name: 'Immich' }),
      testTemplate('navidrome', { name: 'Navidrome' }),
      testTemplate('ollama', { name: 'Ollama' }),
    ]);
    await vi.waitFor(() => expect(store.templates()).toHaveLength(3));
    // A search box only from ten on; the search itself works either way.
    expect(store.searchable()).toBe(false);
    store.setSearch('navi');
    expect(store.shownTemplates()!.map((t) => t.id)).toEqual(['navidrome']);
    store.setSearch('PHOTOS phone');
    expect(store.shownTemplates()!.map((t) => t.id)).toEqual(['immich']);
    store.setSearch('phone music');
    expect(store.shownTemplates()!.map((t) => t.id)).toEqual(['navidrome']);
    await store.useOwnFile();
    store.back();
    expect(store.search()).toBe('phone music');
  });

  it('a template’s form answered after Back and a pasted file: not this setup’s', async () => {
    const { store, appsApi } = await setup();
    const late = new Subject<{ fields: AppField[] }>();
    appsApi.fields.mockReturnValueOnce(late as never);
    await store.chooseTemplate('navidrome');
    store.back();
    await store.useOwnFile();
    late.next({
      fields: [
        {
          key: 'PORT',
          kind: 'port',
          value: '4533',
          default: '4533',
          required: false,
          advanced: false,
        },
      ],
    });
    expect(store.fields()).toBeNull();
    expect(store.env()).toBe('');
  });

  it('installs as the person and follows the output — nothing else: no backup added', async () => {
    const { store, appsApi, backupsApi, asPerson, answers, socket } = await setup();
    const success = vi.spyOn(toast, 'success');
    socket.receive({ event: 'backups:snapshot', data: backupsStatus });
    await store.chooseTemplate('navidrome');
    await vi.waitFor(() => expect(store.fields()).not.toBeNull());
    answers.push(testTask({ output: ['pulling'] }));
    answers.push(testTask({ state: 'succeeded', output: ['pulling', 'started'] }));
    await store.install();
    expect(asPerson).toHaveBeenCalledTimes(1);
    expect(appsApi.install).toHaveBeenCalledWith({
      name: 'navidrome-2',
      folder: null,
      template: 'navidrome',
      compose: COMPOSE,
      env: 'VERSION=0.53\nPORT=4533\n',
    });
    expect(store.step()).toBe('installing');
    await vi.waitFor(() => expect(store.installed()).not.toBeNull(), { timeout: 4000 });
    expect(store.installed()).toEqual({
      name: 'navidrome-2',
      folder: '/home/anna/apps/navidrome-2',
    });
    expect(store.task()?.output).toEqual(['pulling', 'started']);
    expect(success).toHaveBeenCalledWith('navidrome-2 is installed.');
    expect(backupsApi.addItem).not.toHaveBeenCalled();
    expect(asPerson).toHaveBeenCalledTimes(1);
  });

  it('a failed install: its output stays, no hand-over', async () => {
    const { store, answers } = await setup();
    await store.chooseTemplate('navidrome');
    answers.push(testTask({ state: 'failed', output: ['no such image'] }));
    await store.install();
    await vi.waitFor(() => expect(store.task()?.state).toBe('failed'), { timeout: 4000 });
    expect(store.installed()).toBeNull();
    expect(store.step()).toBe('installing');
  });

  it('the page left during the install: no more polls', async () => {
    const { store, page, appsApi, answers } = await setup();
    await store.chooseTemplate('navidrome');
    answers.push(testTask(), testTask(), testTask());
    await store.install();
    await vi.waitFor(() => expect(appsApi.task).toHaveBeenCalled());
    page.destroy();
    const calls = appsApi.task.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(appsApi.task).toHaveBeenCalledTimes(calls);
  });

  it('the sign-in dismissed: nothing started, still on the form', async () => {
    const { store, appsApi, asPerson } = await setup();
    await store.chooseTemplate('navidrome');
    asPerson.mockReturnValueOnce(of(null));
    await store.install();
    expect(appsApi.install).not.toHaveBeenCalled();
    expect(store.step()).toBe('setup');
  });

  it('shows what Compose said when it refused the files, staying on the form', async () => {
    const { store, appsApi } = await setup();
    const error = vi.spyOn(toast, 'error');
    await store.useOwnFile();
    store.setCompose(COMPOSE);
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
