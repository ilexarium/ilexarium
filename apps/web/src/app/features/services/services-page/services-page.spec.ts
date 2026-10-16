import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { CatalogEntrySummary, Container, InstalledService, Job } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { BackupsStore } from '../../../core/backups/backups-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { ServicesApi } from '../../../core/services/services-api';
import { stubScreenWidth } from '../../../layout/testing';
import { ServicesPage } from './services-page';

const SERVICE_ID = '0193a000-0000-7000-8000-0000000000aa';

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
    status: null,
    backupFolders: ['DATA_DIR', 'MUSIC_DIR'],
    backupRestoreNote: false,
  },
];

const job = (change: Partial<Job> = {}): Job => ({
  id: '0193a000-0000-7000-8000-000000000001',
  kind: 'deploy',
  status: 'running',
  phase: 'pulling',
  errorCode: null,
  errorField: null,
  startedAt: '2026-10-12T10:00:00.000Z',
  finishedAt: null,
  output: ['Pulling immich-server'],
  omitted: 0,
  ...change,
});

const immich = (change: Partial<InstalledService> = {}): InstalledService => ({
  id: SERVICE_ID,
  catalogId: 'immich',
  name: 'Immich',
  status: 'installed',
  settings: { WEB_PORT: 2283, UPLOAD_DIR: '/srv/homelab/immich/library' },
  webPort: 2283,
  job: null,
  updatedAt: '2026-10-12T10:00:00.000Z',
  ...change,
});

const container = (change: Partial<Container>): Container => ({
  id: 'c1',
  name: 'hl-immich-immich-server-1',
  image: 'immich',
  state: 'running',
  health: 'healthy',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: 'hl-immich',
  stats: null,
  ...change,
});

async function render() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const api = {
    catalog: vi.fn(async () => catalog),
    remove: vi.fn(async () => ({ jobId: 'j2' })),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: ServicesApi, useValue: api },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const fixture = TestBed.createComponent(ServicesPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const services = async (list: InstalledService[], containers: Container[] = []) => {
    socket.receive({ event: 'services:snapshot', data: { services: list } });
    socket.receive({
      event: 'containers:snapshot',
      data: { dockerAvailable: true, containers, history: {} },
    });
    await fixture.whenStable();
  };
  return { fixture, el, socket, api, services };
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

describe('ServicesPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says on each card whether it is backed up, once backups are set up', async () => {
    const { el, fixture, socket, services } = await render();
    TestBed.inject(BackupsStore).watch();
    await services([immich()]);
    const card = () => el.querySelector('app-installed-service')!;
    expect(card().textContent).not.toContain('backed up');
    const status = (items: object[]) => ({
      event: 'backups:update',
      data: {
        configured: true,
        warnings: [],
        lastSuccessAt: null,
        nextRunAt: null,
        running: null,
        lastRun: null,
        items,
        restore: null,
        lastCheck: null,
      },
    });
    socket.receive(status([]));
    await fixture.whenStable();
    expect(card().textContent).toContain('Not backed up');
    socket.receive(
      status([
        {
          id: '0193a000-0000-7000-8000-0000000000c1',
          kind: 'service',
          serviceId: SERVICE_ID,
          lastSuccessAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          lastStatus: 'ok',
        },
      ]),
    );
    await fixture.whenStable();
    expect(card().textContent).toContain('Backed up 3 hours ago');
    expect(card().querySelector('a[href="/backups"]')).not.toBeNull();
  });

  it('follows the services and containers topics until it is left', async () => {
    const { fixture, socket } = await render();
    expect(socket.sent).toEqual([
      { event: 'subscribe', data: { topic: 'services' } },
      { event: 'subscribe', data: { topic: 'containers' } },
    ]);
    fixture.destroy();
    expect(socket.sent.slice(-2)).toEqual([
      { event: 'unsubscribe', data: { topic: 'services' } },
      { event: 'unsubscribe', data: { topic: 'containers' } },
    ]);
  });

  it('shows the catalog: what each entry is, Install, or its state', async () => {
    const { el, services } = await render();
    await services([immich()]);
    const cards = [...el.querySelectorAll('section[aria-labelledby="catalog-title"] article')];
    expect(cards.map((c) => c.querySelector('h3')!.textContent!.trim())).toEqual([
      'Immich',
      'Navidrome',
    ]);
    expect(cards[1].textContent).toContain('Your own music streaming server');
    const install = cards[1].querySelector('a')!;
    expect(install.getAttribute('href')).toBe('/services/install/navidrome');
    expect(install.getAttribute('aria-label')).toBe('Install Navidrome');
    expect(cards[0].querySelector('a')).toBeNull(); // installed: no Install
    expect(cards[0].textContent).toContain('Installed');
  });

  it('offers to install again after a removal', async () => {
    const { el, services } = await render();
    await services([]); // Immich gone from the installed list
    const card = el.querySelectorAll('section[aria-labelledby="catalog-title"] article')[0];
    expect(card.querySelector('a')!.textContent!.trim()).toBe('Install again');
  });

  it('shows an installed service: its state from its containers, Open on its port', async () => {
    const { el, services } = await render();
    await services([immich()], [container({}), container({ id: 'c2', state: 'exited' })]);
    const card = el.querySelector('section[aria-labelledby="installed-title"] article')!;
    expect(card.textContent).toContain('Partly running');
    const open = card.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(open.getAttribute('href')).toBe(`http://${location.hostname}:2283/`);
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    expect(open.getAttribute('aria-label')).toBe('Open Immich in a new tab');
    expect(card.querySelector('[dir="ltr"]')!.textContent).toBe(':2283');
  });

  it('shows a running job’s steps and output, as text left to right', async () => {
    const { el, services } = await render();
    await services([immich({ status: 'installing', webPort: 2283, job: job() })]);
    const card = el.querySelector('section[aria-labelledby="installed-title"] article')!;
    expect(card.textContent).toContain('Installing…');
    const steps = [...card.querySelectorAll('ol li')].map((li) => li.textContent!.trim());
    expect(steps).toEqual(['Downloading', 'Starting', 'Ready']);
    expect(card.querySelector('[aria-current="step"]')!.textContent!.trim()).toBe('Downloading');
    expect(card.querySelector('pre[dir="ltr"]')!.textContent).toBe('Pulling immich-server');
    expect(card.querySelector('a[target="_blank"]')).toBeNull(); // not open-able while installing
    expect(card.textContent).not.toContain('Remove');
  });

  it('says why a job failed, with its output open, and offers to try again', async () => {
    const { el, services } = await render();
    const failed = job({ status: 'failed', phase: 'starting', errorCode: 'compose_failed' });
    await services([immich({ status: 'failed', job: failed })]);
    const card = el.querySelector('section[aria-labelledby="installed-title"] article')!;
    expect(card.querySelector('[role="alert"]')!.textContent).toContain(
      'The service could not be started. The output shows why.',
    );
    expect(card.querySelector('details')!.open).toBe(true);
    expect(card.querySelector('a[href="/services/install/immich"]')!.textContent!.trim()).toBe(
      'Try again',
    );
  });

  it('removes after a confirmation that says the data stays', async () => {
    const { el, services, api } = await render();
    await services([immich()], [container({})]);
    const remove = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent!.includes('Remove'),
    )!;
    remove.click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.textContent).toContain('Remove Immich?');
    expect(dialog()!.textContent).toContain('Its data and settings are kept');
    const cancel = [...dialog()!.querySelectorAll('button')].find(
      (b) => b.textContent!.trim() === 'Cancel',
    )!;
    cancel.click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(api.remove).not.toHaveBeenCalled();

    remove.click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    [...dialog()!.querySelectorAll('button')]
      .find((b) => b.textContent!.trim() === 'Remove')!
      .click();
    await vi.waitFor(() => expect(api.remove).toHaveBeenCalledWith(SERVICE_ID));
  });

  it('says in plain words when a removal can’t start', async () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue(0);
    const { el, services, api } = await render();
    api.remove.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 409, error: { message: 'x', code: 'busy' } }),
    );
    await services([immich()]);
    [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent!.includes('Remove'))!
      .click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    [...dialog()!.querySelectorAll('button')]
      .find((b) => b.textContent!.trim() === 'Remove')!
      .click();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(error).toHaveBeenCalledWith("Couldn't remove Immich", {
      description:
        'Another operation (an install, a backup, a restore or a disk being mounted) is running. Try again when it has finished.',
    });
  });

  it('works on phones: cards, no table, nothing hover-only', async () => {
    const restore = stubScreenWidth(375);
    try {
      const { el, services } = await render();
      await services([immich()]);
      expect(el.querySelector('table')).toBeNull();
      expect(el.querySelectorAll('article').length).toBe(3);
    } finally {
      restore();
    }
  });

  it('says when nothing is installed yet', async () => {
    const { el, services } = await render();
    await services([]);
    expect(el.textContent).toContain('Nothing installed yet.');
  });
});
