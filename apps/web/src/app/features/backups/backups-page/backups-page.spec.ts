import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type {
  BackupDestination,
  BackupFoldersResponse,
  BackupPlan,
  BackupsStatus,
  Container,
} from '@ilex/shared';
import { defer, type Observable, of, throwError } from 'rxjs';
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
import { toast } from '@spartan-ng/brain/sonner';

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

async function render(start: BackupPlan | null, url = '/backups') {
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
    folders: vi.fn((_path?: string): Observable<BackupFoldersResponse> =>
      of({ path: null, parent: null, readable: true, folders: [] }),
    ),
    setup: vi.fn(() =>
      defer(() => {
        current = plan();
        return of({ passphrase: PASSPHRASE });
      }),
    ),
    runNow: vi.fn(() => of({ runId: 'r1' })),
    updateItem: vi.fn(() => of(null)),
    // 204: no body.
    removeItem: vi.fn(() => of(null)),
    passphrase: vi.fn(() => of({ passphrase: PASSPHRASE })),
    // 204: no body.
    refreshArchives: vi.fn((): Observable<unknown> => of(null)),
    archives: vi.fn(() =>
      of({
        archives: [
          { name: `${IMMICH_ITEM}-2026-11-16T03:00:00`, createdAt: '2026-11-16T03:00:00Z' },
        ],
      }),
    ),
    applyRestored: vi.fn(() =>
      of({ name: 'immich', folder: '/home/anna/apps/immich', task: null }),
    ),
  };
  const apps = {
    templates: vi.fn(() => of([])),
    // Immich's template: stopped while backed up, its thumbnails skipped.
    template: vi.fn(() =>
      of({ template: { backup: { mode: 'stop', skip: ['thumbs'] } }, compose: '' }),
    ),
  };
  // Signed in to Linux with sudo at hand: every action goes straight through.
  const asPerson = vi.fn(<T>(action: () => Promise<T>) => action());
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'backups', component: BackupsPage }]),
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
  const harness = await RouterTestingHarness.create(url);
  const fixture = harness.fixture;
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
  const el = harness.routeNativeElement!;
  const store = harness.routeDebugElement!.injector.get(BackupsPageStore);
  const pushStatus = async (data: BackupsStatus) => {
    socket.receive({ event: 'backups:update', data });
    await fixture.whenStable();
  };
  const button = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes(text),
    )!;
  return { fixture, el, api, asPerson, socket, pushStatus, button, store };
}

/** "⋯" → "Show the passphrase again" (the header shows once the topic's status is in). */
async function morePassphrase(el: HTMLElement) {
  await vi.waitFor(() =>
    expect(el.querySelector('button[aria-label="More backup actions"]')).not.toBeNull(),
  );
  el.querySelector<HTMLButtonElement>('button[aria-label="More backup actions"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((i) => i.textContent?.includes('Show the passphrase again'))!
    .click();
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

  it('sums up the choice beside the form on desktop, Set up in a bar on phones', async () => {
    const { el, fixture } = await render(null);
    const summary = el.querySelector<HTMLElement>('[data-setup-summary]')!;
    const bar = el.querySelector<HTMLElement>('[data-setup-bar]')!;
    expect(summary.closest('aside')!.className).toContain('hidden lg:block');
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('lg:hidden');
    expect(summary.textContent).toContain('No disk chosen yet');
    expect(summary.textContent).toContain('This app');
    expect(summary.textContent).toContain('2 apps');
    expect(summary.textContent).toContain('Every day · 03:00');
    el.querySelector<HTMLInputElement>('input[value="/mnt/usb"]')!.click();
    [...el.querySelectorAll('label')]
      .find((l) => l.textContent?.trim() === 'notes')!
      .querySelector('input')!
      .click();
    await fixture.whenStable();
    expect(summary.textContent).toContain('/mnt/usb');
    expect(summary.textContent).toContain('1 app');
    expect(bar.textContent).toContain('/mnt/usb');
    expect(bar.querySelector('button[type="submit"]')!.textContent).toContain('Set up backups');
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
  it('names each item on its card: this app, the app, the folder (left to right)', async () => {
    const { el } = await render(plan());
    const names = [...el.querySelectorAll<HTMLElement>('[data-open-sheet]')];
    expect(names.map((n) => n.textContent!.trim())).toEqual([
      'This app',
      'immich',
      '/home/alice/Documents',
    ]);
    expect(names.map((n) => n.getAttribute('dir'))).toEqual([null, 'ltr', 'ltr']);
    const cards = el.querySelector('ilex-backup-items > ul')!;
    expect(cards.textContent).toContain('A folder to back up is missing.');
    expect(cards.textContent).toContain(formatBytes(2e9));
  });

  it('says how backups stand in one line: all good, attention, running', async () => {
    const { el, pushStatus } = await render(plan());
    const headline = () => el.querySelector('[data-headline]')!.textContent!.trim();
    // The folder's last backup failed.
    await pushStatus(status({ warnings: ['lastRunFailed'] }));
    expect(headline()).toBe('1 thing needs attention');
    await pushStatus(status({ warnings: ['lastRunFailed', 'lowSpace'] }));
    expect(headline()).toBe('2 things need attention');
    await pushStatus(
      status({
        running: {
          runId: '0193a000-0000-7000-8000-0000000000ff',
          trigger: 'manual',
          startedAt: ago(0),
          items: [
            { itemId: PLATFORM, state: 'done', phase: null, result: null },
            { itemId: IMMICH_ITEM, state: 'running', phase: 'archiving', result: null },
          ],
          output: [],
        },
      }),
    );
    expect(headline()).toBe('Backing up… 1 of 2');
  });

  it('says everything is backed up when nothing failed', async () => {
    const healthy = plan();
    healthy.items = healthy.items.slice(0, 2);
    const { el, pushStatus } = await render(healthy);
    await pushStatus(status());
    expect(el.querySelector('[data-headline]')!.textContent).toContain(
      'Everything is backed up · 9 hours ago',
    );
    await pushStatus(status({ lastSuccessAt: null }));
    expect(el.querySelector('[data-headline]')!.textContent).toContain(
      'Not everything is backed up yet',
    );
  });

  it('doesn’t say everything is backed up while an item added since never was', async () => {
    const fresh = plan();
    fresh.items = [fresh.items[0], { ...fresh.items[1], lastSuccessAt: null, lastResult: null }];
    const { el, pushStatus } = await render(fresh);
    await pushStatus(status());
    expect(el.querySelector('[data-headline]')!.textContent).toContain(
      'Not everything is backed up yet',
    );
  });

  it('keeps the open tab in the URL', async () => {
    const { el, fixture, button } = await render(plan(), '/backups?tab=history');
    const shown = () =>
      [...el.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
        .filter((p) => !p.hidden && p.childElementCount > 0)
        .map(
          (p) =>
            p.querySelector('ilex-backup-items, ilex-backup-history, ilex-backup-settings')
              ?.tagName,
        );
    expect(shown()).toEqual(['ILEX-BACKUP-HISTORY']);
    expect(el.textContent).toContain('No backups have run yet.');
    button('Settings').click();
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/backups?tab=settings'));
    await fixture.whenStable();
    expect(shown()).toEqual(['ILEX-BACKUP-SETTINGS']);
    button('What’s backed up').click();
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/backups'));
  });

  it('opens an item’s sheet from its card; a folder change is saved as the person', async () => {
    const { el, api, asPerson, fixture } = await render(plan());
    [...el.querySelectorAll<HTMLButtonElement>('[data-open-sheet]')][1].click();
    await vi.waitFor(() => expect(document.querySelector('[data-item-sheet]')).not.toBeNull());
    const sheet = document.querySelector<HTMLElement>('[data-item-sheet]')!;
    expect(sheet.querySelector('h2')!.textContent!.trim()).toBe('immich');
    expect(sheet.textContent).toContain('/home/anna/apps/immich/data');
    asPerson.mockClear();
    const before = api.plan.mock.calls.length;
    sheet.querySelector<HTMLSelectElement>('#item-mode')!.value = 'live';
    sheet.querySelector('#item-mode')!.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(api.updateItem).toHaveBeenCalledWith(IMMICH_ITEM, { mode: 'live' }),
    );
    expect(asPerson).toHaveBeenCalled();
    await vi.waitFor(() => expect(api.plan.mock.calls.length).toBeGreaterThan(before));
    sheet.querySelector<HTMLButtonElement>('button[hlmSheetClose]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-item-sheet]')).toBeNull());
    await fixture.whenStable();
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
    const { api, store } = await render(plan());
    const before = api.plan.mock.calls.length;
    await store.removeItem({ itemId: FOLDER_ITEM, deleteArchives: false });
    expect(api.removeItem).toHaveBeenCalledWith(FOLDER_ITEM, false);
    await vi.waitFor(() => expect(api.plan.mock.calls.length).toBeGreaterThan(before));
  });

  it('Restore…: the lists read again from the disk as the person first, then this item’s', async () => {
    const { api, asPerson, store } = await render(plan());
    asPerson.mockClear();
    store.loadArchives(IMMICH_ITEM);
    await vi.waitFor(() => expect(store.archives()?.list).toHaveLength(1));
    expect(asPerson).toHaveBeenCalledTimes(1);
    expect(api.refreshArchives).toHaveBeenCalled();
    expect(api.archives).toHaveBeenCalledWith(IMMICH_ITEM);
  });

  it('Restore…: refused (said, unless a backup holds the disk) or the prompt closed, the saved list all the same', async () => {
    const { api, asPerson, store } = await render(plan());
    const toastError = vi.spyOn(toast, 'error');
    api.refreshArchives.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 409, error: { code: 'busy' } })),
    );
    store.loadArchives(IMMICH_ITEM);
    await vi.waitFor(() => expect(api.archives).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
    api.refreshArchives.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 502, error: { code: 'borg_failed' } })),
    );
    store.loadArchives(IMMICH_ITEM);
    await vi.waitFor(() => expect(api.archives).toHaveBeenCalledTimes(2));
    expect(store.archives()?.list).toHaveLength(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    asPerson.mockResolvedValueOnce(null);
    store.loadArchives(IMMICH_ITEM);
    await vi.waitFor(() => expect(api.archives).toHaveBeenCalledTimes(3));
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('applies a restored app’s settings as the person, in its own folder', async () => {
    const { api, asPerson, store } = await render(plan());
    const before = api.plan.mock.calls.length;
    await store.applyRestored({ id: 'r1', itemId: IMMICH_ITEM } as never);
    expect(asPerson).toHaveBeenCalled();
    expect(api.applyRestored).toHaveBeenCalledWith('r1', '/home/anna/apps/immich');
    // The restore no longer offers it: read again.
    await vi.waitFor(() => expect(api.plan.mock.calls.length).toBeGreaterThan(before));
  });

  it('shows the passphrase again through the person’s sudo, from "⋯"', async () => {
    const { el, api, asPerson, pushStatus } = await render(plan());
    await pushStatus(status());
    await morePassphrase(el);
    await vi.waitFor(() => expect(api.passphrase).toHaveBeenCalledWith());
    expect(asPerson).toHaveBeenCalled();
    await vi.waitFor(() => expect(el.textContent).toContain('dolphin'));
  });

  it('shows nothing when the sudo prompt is closed', async () => {
    const { el, api, asPerson, fixture, pushStatus } = await render(plan());
    await pushStatus(status());
    asPerson.mockResolvedValueOnce(null);
    await morePassphrase(el);
    await fixture.whenStable();
    expect(api.passphrase).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain('dolphin');
  });

  it('the folder picker reads as the Linux account: its sign-in first; closed, nothing changes', async () => {
    const { api, asPerson, store, fixture } = await render(plan());
    const anna = {
      path: '/home/anna',
      parent: '/home',
      readable: true,
      folders: [{ name: 'Photos', path: '/home/anna/Photos', allowed: true }],
    };
    api.folders.mockReturnValue(of(anna));
    asPerson.mockClear();
    store.browse('/home/anna');
    await fixture.whenStable();
    expect(asPerson).toHaveBeenCalledTimes(1);
    expect(api.folders).toHaveBeenLastCalledWith('/home/anna');
    expect(store.folders()).toEqual(anna);

    // The sign-in closed: the listing stays as it was.
    asPerson.mockResolvedValueOnce(null);
    store.browse('/home/anna/Photos');
    await fixture.whenStable();
    expect(store.folders()).toEqual(anna);
  });
});
