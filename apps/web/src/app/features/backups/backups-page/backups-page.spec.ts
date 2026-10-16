import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  BackupDestination,
  BackupPlan,
  BackupsStatus,
  CatalogEntrySummary,
  InstalledService,
} from '@homelab/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { ServicesApi } from '../../../core/services/services-api';
import { formatBytes } from '../../../shared/format/format';
import { BackupsPage } from './backups-page';

const PLATFORM = '0193a000-0000-7000-8000-000000000001';
const IMMICH_ITEM = '0193a000-0000-7000-8000-000000000002';
const FOLDER_ITEM = '0193a000-0000-7000-8000-000000000003';
const IMMICH = '0193a000-0000-7000-8000-0000000000aa';
const NAVIDROME = '0193a000-0000-7000-8000-0000000000bb';
const PASSPHRASE = 'acorn bagel cactus dolphin ember fjord';

const catalog: CatalogEntrySummary[] = [
  {
    id: 'immich',
    name: 'Immich',
    category: 'photos',
    status: 'installed',
    backupFolders: ['UPLOAD_DIR'],
    backupRestoreNote: true,
  },
  {
    id: 'navidrome',
    name: 'Navidrome',
    category: 'media',
    status: 'installed',
    backupFolders: ['DATA_DIR', 'MUSIC_DIR'],
    backupRestoreNote: false,
  },
];

const service = (id: string, catalogId: string, name: string): InstalledService => ({
  id,
  catalogId,
  name,
  status: 'installed',
  settings: {},
  webPort: null,
  job: null,
  updatedAt: '2026-10-14T00:00:00.000Z',
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
    {
      id: PLATFORM,
      kind: 'platform',
      serviceId: null,
      catalogId: null,
      path: null,
      excludedFields: [],
      removed: false,
      lastSuccessAt: ago(9),
      lastResult: null,
    },
    {
      id: IMMICH_ITEM,
      kind: 'service',
      serviceId: IMMICH,
      catalogId: 'immich',
      path: null,
      excludedFields: [],
      removed: false,
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
    },
    {
      id: FOLDER_ITEM,
      kind: 'folder',
      serviceId: null,
      catalogId: null,
      path: '/home/alice/Documents',
      excludedFields: [],
      removed: false,
      lastSuccessAt: null,
      lastResult: {
        itemId: FOLDER_ITEM,
        status: 'failed',
        errorCode: 'source_missing',
        archive: null,
        originalBytes: null,
        addedBytes: null,
        warnings: [],
      },
    },
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
    plan: vi.fn(async () => ({ plan: current })),
    destinations: vi.fn(async () => ({
      destinations: [
        disk(),
        disk({ mountPoint: '/media/alice/stick', filesystem: 'vfat', supported: false }),
        disk({ mountPoint: '/mnt/data', sameDiskAsData: true }),
      ],
    })),
    runs: vi.fn(async () => ({ runs: [] })),
    restores: vi.fn(async () => ({ restores: [] })),
    folders: vi.fn(async () => ({ path: null, parent: null, readable: true, folders: [] })),
    setup: vi.fn(async () => {
      current = plan();
      return { passphrase: PASSPHRASE };
    }),
    runNow: vi.fn(async () => ({ runId: 'r1' })),
    passphrase: vi.fn(async () => ({ passphrase: PASSPHRASE })),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: BackupsApi, useValue: api },
      { provide: ServicesApi, useValue: { catalog: vi.fn(async () => catalog) } },
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
    event: 'services:snapshot',
    data: {
      services: [service(IMMICH, 'immich', 'Immich'), service(NAVIDROME, 'navidrome', 'Navidrome')],
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
  return { fixture, el, api, socket, pushStatus, button };
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

describe('BackupsPage before setup', () => {
  it('offers the mounted disks, warns about the data’s own disk, refuses unsupported ones', async () => {
    const { el } = await render(null);
    const radios = [...el.querySelectorAll<HTMLInputElement>('input[name="destination"]')];
    expect(radios.map((r) => r.value)).toEqual(['/mnt/usb', '/media/alice/stick', '/mnt/data']);
    expect(radios[1].disabled).toBe(true);
    expect(el.textContent).toContain("can't be used for backups");
    expect(el.textContent).toContain('This is the same disk as your data');
  });

  it('sets up with the chosen disk and services, then shows the passphrase until it is saved', async () => {
    const { el, api, fixture, button } = await render(null);
    el.querySelector<HTMLInputElement>('input[value="/mnt/usb"]')!.click();
    // Navidrome's music folder switched off.
    const music = [...el.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Music folder'),
    )!;
    music.querySelector('input')!.click();
    await fixture.whenStable();
    button('Set up backups').click();
    await vi.waitFor(() => expect(api.setup).toHaveBeenCalled());
    expect(api.setup).toHaveBeenCalledWith({
      destination: '/mnt/usb',
      schedule: { frequency: 'daily', time: '03:00' },
      retention: { daily: 7, weekly: 4, monthly: 6 },
      items: [
        { kind: 'service', serviceId: IMMICH, excludedFields: [] },
        { kind: 'service', serviceId: NAVIDROME, excludedFields: ['MUSIC_DIR'] },
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

  it('asks for a disk before setting up', async () => {
    const { el, api, fixture, button } = await render(null);
    button('Set up backups').click();
    await fixture.whenStable();
    expect(api.setup).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Choose a disk');
  });

  it('shows the server’s refusal', async () => {
    const { el, api, fixture, button } = await render(null);
    api.setup.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 409, error: { message: 'x', code: 'repository_exists' } }),
    );
    el.querySelector<HTMLInputElement>('input[value="/mnt/usb"]')!.click();
    button('Set up backups').click();
    await vi.waitFor(() => expect(el.textContent).toContain('already has a backup folder'));
    await fixture.whenStable();
  });
});

describe('BackupsPage with a plan', () => {
  it('names each item: this app, the service, the folder (left to right)', async () => {
    const { el } = await render(plan());
    const items = el.querySelector('section[aria-labelledby="items-title"]')!;
    expect(items.textContent).toContain('This app');
    expect(items.textContent).toContain('Immich');
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
    expect(el.textContent).toContain('Immich — copying');
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

  it('shows the passphrase again only with the password', async () => {
    const { el, api, fixture, button } = await render(plan());
    button('Show the passphrase again').click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    const password = dialog()!.querySelector<HTMLInputElement>('#confirm-password')!;
    api.passphrase.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 400,
        error: {
          message: 'Validation failed',
          errors: [{ field: 'password', code: 'wrong_password', message: 'x' }],
        },
      }),
    );
    password.value = 'nope';
    password.dispatchEvent(new Event('input'));
    [...dialog()!.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Show')!
      .click();
    await vi.waitFor(() => expect(dialog()!.textContent).toContain('password is incorrect'));
    password.value = 'correct horse';
    password.dispatchEvent(new Event('input'));
    [...dialog()!.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Show')!
      .click();
    await vi.waitFor(() => expect(api.passphrase).toHaveBeenLastCalledWith('correct horse'));
    await fixture.whenStable();
    await vi.waitFor(() => expect(el.textContent).toContain('dolphin'));
  });
});
