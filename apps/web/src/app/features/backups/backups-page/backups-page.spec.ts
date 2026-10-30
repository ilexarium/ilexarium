import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { BackupDestination, BackupPlan, BackupsStatus, Container } from '@laris/shared';
import { defer, of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { AppsApi } from '../../../core/apps/apps-api';
import { testAppItem, testItem } from '../../../core/backups/testing';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { formatBytes } from '../../../shared/format/format';
import { BackupsPage } from './backups-page';
import { BackupsPageStore } from './backups-page-store';

const PLATFORM = '0193a000-0000-7000-8000-000000000001';
const IMMICH_ITEM = '0193a000-0000-7000-8000-000000000002';
const FOLDER_ITEM = '0193a000-0000-7000-8000-000000000003';
const PASSPHRASE = 'acorn bagel cactus dolphin ember fjord';

/** An app's container as the containers topic shows it. */
const container = (project: string, template: string | null): Omit<Container, 'stats'> => ({
  id: project,
  name: `${project}-server-1`,
  image: `example/${project}:1`,
  state: 'running',
  health: 'none',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: project,
  composeWorkingDir: `/home/anna/apps/${project}`,
  template,
});

const disk = (change: Partial<BackupDestination> = {}): BackupDestination => ({
  mountPoint: '/mnt/usb',
  filesystem: 'ext4',
  supported: true,
  totalBytes: 1e12,
  freeBytes: 6e11,
  sameDiskAsData: false,
  hasRepository: false,
  ...change,
});

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const plan = (): BackupPlan => ({
  destination: '/mnt/usb',
  schedule: { frequency: 'daily', time: '03:00' },
  retention: { daily: 7, weekly: 4, monthly: 6 },
  destinationStatus: disk({ hasRepository: true }),
  items: [
    testItem({ id: PLATFORM, kind: 'platform', path: null, lastSuccessAt: ago(9) }),
    testAppItem('immich', {
      id: IMMICH_ITEM,
      lastSuccessAt: ago(9),
      lastResult: {
        itemId: IMMICH_ITEM,
        status: 'ok',
        errorCode: null,
        archive: 'a',
        originalBytes: 2e9,
        addedBytes: 1e6,
        warnings: [],
      },
    }),
    testItem({
      id: FOLDER_ITEM,
      path: '/home/alice/Documents',
      lastResult: {
        itemId: FOLDER_ITEM,
        status: 'failed',
        errorCode: 'source_missing',
        archive: null,
        originalBytes: null,
        addedBytes: null,
        warnings: [],
      },
    }),
  ],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const status = (change: Partial<BackupsStatus> = {}): BackupsStatus => ({
  configured: true,
  warnings: [],
  lastSuccessAt: ago(9),
  nextRunAt: '2026-10-15T03:00:00.000Z',
  running: null,
  lastRun: null,
  items: [],
  restore: null,
  lastCheck: null,
  ...change,
});

async function render(start: BackupPlan | null) {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  let current = start;
  const api = {
    plan: vi.fn(() => of({ plan: current })),
    destinations: vi.fn(() =>
      of({
        destinations: [
          disk(),
          disk({ mountPoint: '/media/alice/stick', filesystem: 'vfat', supported: false }),
          disk({ mountPoint: '/mnt/data', sameDiskAsData: true }),
        ],
      }),
    ),
    runs: vi.fn(() => of({ runs: [] })),
    restores: vi.fn(() => of({ restores: [] })),
    folders: vi.fn(() => of({ path: null, parent: null, readable: true, folders: [] })),
    setup: vi.fn(() =>
      defer(() => {
        current = plan();
        return of({ passphrase: PASSPHRASE });
      }),
    ),
    runNow: vi.fn(() => of({ runId: 'r1' })),
    // 204: no body.
    removeItem: vi.fn(() => of(null)),
    passphrase: vi.fn(() => of({ passphrase: PASSPHRASE })),
  };
  const apps = {
    templates: vi.fn(() => of([])),
    // Immich's template: stopped while backed up, its thumbnails skipped.
    template: vi.fn(() =>
      of({ template: { backup: { mode: 'stop', skip: ['thumbs'] } }, compose: '' }),
    ),
    apply: vi.fn(() => of({ name: 'immich', folder: '/home/anna/apps/immich', task: null })),
  };
  // Signed in to Linux with sudo at hand: every action goes straight through.
  const asPerson = vi.fn(<T>(action: () => Promise<T>) => action());
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: BackupsApi, useValue: api },
      { provide: AppsApi, useValue: apps },
      { provide: LinuxSessionStore, useValue: { asPerson } },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  // The shell follows the backups topic all session long.
  TestBed.inject(BackupsStore).watch();
  const fixture = TestBed.createComponent(BackupsPage);
  await fixture.whenStable();
  socket.receive({
    event: 'containers:snapshot',
    data: {
      dockerAvailable: true,
      containers: [
        { ...container('immich', 'immich@2'), stats: null },
        { ...container('notes', null), stats: null },
      ],
      history: {},
    },
  });
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const pushStatus = async (data: BackupsStatus) => {
    socket.receive({ event: 'backups:update', data });
    await fixture.whenStable();
  };
  const button = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes(text),
    )!;
  return { fixture, el, api, apps, asPerson, socket, pushStatus, button };
}

describe('BackupsPage before setup', () => {
  it('offers the mounted disks, warns about the data’s own disk, refuses unsupported ones', async () => {
    const { el } = await render(null);
    const radios = [...el.querySelectorAll<HTMLInputElement>('input[name="destination"]')];
    expect(radios.map((r) => r.value)).toEqual(['/mnt/usb', '/media/alice/stick', '/mnt/data']);
    expect(radios[1].disabled).toBe(true);
    expect(el.textContent).toContain("can't be used for backups");
    expect(el.textContent).toContain('This is the same disk as your data');
  });

  it('sets up as the person with the chosen disk and apps (templates’ presets), then shows the passphrase until saved', async () => {
    const { el, api, asPerson, fixture, button } = await render(null);
    el.querySelector<HTMLInputElement>('input[value="/mnt/usb"]')!.click();
    expect([...el.querySelectorAll('label')].map((l) => l.textContent?.trim())).toContain('notes');
    button('Set up backups').click();
    await vi.waitFor(() => expect(api.setup).toHaveBeenCalled());
    expect(asPerson).toHaveBeenCalled();
    expect(api.setup).toHaveBeenCalledWith({
      destination: '/mnt/usb',
      schedule: { frequency: 'daily', time: '03:00' },
      retention: { daily: 7, weekly: 4, monthly: 6 },
      items: [
        {
          kind: 'app',
          project: 'immich',
          folders: [],
          skip: ['/home/anna/apps/immich/thumbs'],
          mode: 'stop',
        },
        { kind: 'app', project: 'notes', folders: [], skip: [], mode: 'stop' },
      ],
    });
    await fixture.whenStable();
    const words = [...el.querySelectorAll('ol li')].map((li) => li.lastElementChild!.textContent);
    expect(words).toEqual(PASSPHRASE.split(' '));
    expect(el.querySelector('ol')!.getAttribute('dir')).toBe('ltr');
    button("I've saved it").click();
    await fixture.whenStable();
    expect(el.textContent).not.toContain('acorn');
  });

  it('leaves out an app switched off', async () => {
    const { el, api, fixture, button } = await render(null);
    el.querySelector<HTMLInputElement>('input[value="/mnt/usb"]')!.click();
    [...el.querySelectorAll('label')]
      .find((l) => l.textContent?.trim() === 'notes')!
      .querySelector('input')!
      .click();
    await fixture.whenStable();
    button('Set up backups').click();
    await vi.waitFor(() => expect(api.setup).toHaveBeenCalled());
    expect(api.setup).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ project: 'immich' })] }),
    );
  });

  it('asks for a disk before setting up', async () => {
    const { el, api, fixture, button } = await render(null);
    button('Set up backups').click();
    await fixture.whenStable();
    expect(api.setup).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Choose a disk');
  });

  it('shows the server’s refusal', async () => {
    const { el, api, fixture, button } = await render(null);
    api.setup.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: { message: 'x', code: 'repository_exists' },
          }),
      ),
    );
    el.querySelector<HTMLInputElement>('input[value="/mnt/usb"]')!.click();
    button('Set up backups').click();
    await vi.waitFor(() => expect(el.textContent).toContain('already has a backup folder'));
    await fixture.whenStable();
  });
});

describe('BackupsPage with a plan', () => {
  it('names each item: this app, the app, the folder (left to right)', async () => {
    const { el } = await render(plan());
    const items = el.querySelector('section[aria-labelledby="items-title"]')!;
    expect(items.textContent).toContain('This app');
    expect(items.textContent).toContain('immich');
    const path = [...items.querySelectorAll('p')].find(
      (p) => p.textContent?.trim() === '/home/alice/Documents',
    )!;
    expect(path.getAttribute('dir')).toBe('ltr');
    expect(items.textContent).toContain('A folder to back up is missing.');
    expect(items.textContent).toContain(formatBytes(2e9));
  });

  it('backs up now', async () => {
    const { api, button, pushStatus } = await render(plan());
    await pushStatus(status());
    button('Back up now').click();
    await vi.waitFor(() => expect(api.runNow).toHaveBeenCalledWith(undefined));
  });

  it('shows the warnings and a running backup’s progress, live', async () => {
    const { el, pushStatus, button } = await render(plan());
    await pushStatus(
      status({
        warnings: ['lastRunFailed'],
        running: {
          runId: '0193a000-0000-7000-8000-0000000000ff',
          trigger: 'scheduled',
          startedAt: ago(0),
          items: [
            { itemId: PLATFORM, state: 'done', phase: null, result: null },
            { itemId: IMMICH_ITEM, state: 'running', phase: 'archiving', result: null },
            { itemId: FOLDER_ITEM, state: 'waiting', phase: null, result: null },
          ],
          output: [],
        },
      }),
    );
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('The last backup failed');
    expect(el.textContent).toContain('Scheduled backup running: 1 of 3 done');
    expect(el.textContent).toContain('immich — copying');
    expect(button('Back up now').disabled).toBe(true);
  });

  it('reloads the plan and the history when a run ends', async () => {
    const { api, pushStatus } = await render(plan());
    await pushStatus(status());
    const before = api.plan.mock.calls.length;
    await pushStatus(
      status({
        lastRun: {
          id: '0193a000-0000-7000-8000-0000000000fe',
          trigger: 'scheduled',
          itemId: null,
          status: 'ok',
          errorCode: null,
          startedAt: ago(1),
          finishedAt: ago(0),
          items: [],
        },
      }),
    );
    await vi.waitFor(() => expect(api.plan.mock.calls.length).toBeGreaterThan(before));
    expect(api.runs).toHaveBeenCalledTimes(2);
  });

  it('shows a removed item gone at once (an empty answer is done, not cancelled)', async () => {
    const { api, fixture } = await render(plan());
    const before = api.plan.mock.calls.length;
    const store = fixture.debugElement.injector.get(BackupsPageStore);
    await store.removeItem({ itemId: FOLDER_ITEM, deleteArchives: false });
    expect(api.removeItem).toHaveBeenCalledWith(FOLDER_ITEM, false);
    await vi.waitFor(() => expect(api.plan.mock.calls.length).toBeGreaterThan(before));
  });

  it('applies a restored app’s settings as the person, in its own folder', async () => {
    const { apps, asPerson, fixture } = await render(plan());
    const store = fixture.debugElement.injector.get(BackupsPageStore);
    await store.applyRestored({ id: 'r1', itemId: IMMICH_ITEM } as never);
    expect(asPerson).toHaveBeenCalled();
    expect(apps.apply).toHaveBeenCalledWith('immich', '/home/anna/apps/immich');
    expect(store.applied()).toEqual(['r1']);
  });

  it('shows the passphrase again through the person’s sudo', async () => {
    const { el, api, asPerson, button } = await render(plan());
    button('Show the passphrase again').click();
    await vi.waitFor(() => expect(api.passphrase).toHaveBeenCalledWith());
    expect(asPerson).toHaveBeenCalled();
    await vi.waitFor(() => expect(el.textContent).toContain('dolphin'));
  });

  it('shows nothing when the sudo prompt is closed', async () => {
    const { el, api, asPerson, button, fixture } = await render(plan());
    asPerson.mockResolvedValueOnce(null);
    button('Show the passphrase again').click();
    await fixture.whenStable();
    expect(api.passphrase).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain('dolphin');
  });
});
