import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import type { Container, DockerCleanup } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { ContainersApi } from '../../../core/containers/containers-api';
import { DockerCleanupApi } from '../../../core/containers/docker-cleanup-api';
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

const CLEANUP: DockerCleanup = {
  images: [{ id: 'aaaaaaaaaaaa', tags: ['debian:13'], bytes: 2e8, created: null }],
  imagesBytes: 2e8,
  buildCacheBytes: 0,
  volumes: [{ name: 'music_cache', app: 'music', anonymous: false, created: null }],
};

async function render(cleanup: DockerCleanup | null = CLEANUP) {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const api = { act: vi.fn(() => of(null)) };
  const cleanupApi = {
    overview: vi.fn(() =>
      cleanup ? of(cleanup) : throwError(() => new HttpErrorResponse({ status: 503 })),
    ),
    volumeSizes: vi.fn(() => of({ sizes: { music_cache: 2.1e9 } })),
    prune: vi.fn(() => of({ bytesFreed: 3e9, images: 1 })),
    removeVolume: vi.fn(() => of(undefined)),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: ContainersApi, useValue: api },
      { provide: DockerCleanupApi, useValue: cleanupApi },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const fixture = TestBed.createComponent(ContainersPage);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, socket, api, cleanupApi };
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;

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

  describe('free space', () => {
    afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

    it('reads what can be freed, then the volume sizes', async () => {
      const { el, cleanupApi } = await render();
      expect(cleanupApi.overview).toHaveBeenCalledTimes(1);
      expect(cleanupApi.volumeSizes).toHaveBeenCalledTimes(1);
      expect(el.querySelector('#free-space')!.textContent).toContain('2.1 GB');
    });

    it('frees images and cache after confirming, says how much, and reads again', async () => {
      const success = vi.spyOn(toast, 'success');
      const { fixture, el, cleanupApi } = await render();
      button(el, 'Free 200 MB').click();
      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
      await fixture.whenStable();
      button(dialog(), 'Free space').click();
      await vi.waitFor(() => expect(success).toHaveBeenCalledWith('Freed 3.0 GB'));
      expect(cleanupApi.prune).toHaveBeenCalledTimes(1);
      expect(cleanupApi.overview).toHaveBeenCalledTimes(2);
    });

    it('deletes a volume after confirming; Docker’s refusal comes as a toast', async () => {
      const error = vi.spyOn(toast, 'error');
      const { fixture, el, cleanupApi } = await render();
      cleanupApi.removeVolume.mockReturnValueOnce(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 409,
              error: { message: 'in use', code: 'volume_in_use' },
            }),
        ),
      );
      el.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete volume music_cache"]',
      )!.click();
      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
      await fixture.whenStable();
      button(dialog(), 'Delete volume').click();
      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith('Volume music_cache couldn’t be deleted', {
          description: 'A container uses this volume. Remove the container first.',
        }),
      );
      expect(cleanupApi.removeVolume).toHaveBeenCalledWith('music_cache');
    });

    it('shows no card when Docker can’t be asked', async () => {
      const { el } = await render(null);
      expect(el.querySelector('#free-space')).toBeNull();
    });
  });

  describe('headline', () => {
    const running: Container = { ...stopped, id: 'r1', name: 'web', state: 'running' };
    const headline = async (...containers: Container[]) => {
      const { fixture, el, socket } = await render();
      socket.receive({
        event: 'containers:snapshot',
        data: { dockerAvailable: true, containers, history: {} },
      });
      await fixture.whenStable();
      return el.querySelector('p[role="status"]')?.textContent!.trim() ?? null;
    };

    it('says when the one container runs', async () => {
      expect(await headline(running)).toBe('Your container is running');
    });

    it('says when all run', async () => {
      expect(await headline(running, { ...running, id: 'r2', name: 'api' })).toBe(
        'All 2 containers are running',
      );
    });

    it('says how many of them run', async () => {
      expect(await headline(running, stopped)).toBe('1 of 2 containers is running');
    });

    it('leads with what needs attention: unhealthy, restarting or dead — not a plain stop', async () => {
      expect(
        await headline(
          { ...running, health: 'unhealthy' },
          { ...stopped, id: 'd', name: 'dead', state: 'dead' },
          stopped,
        ),
      ).toBe('2 containers need your attention');
    });

    it('says nothing without containers (the table says so)', async () => {
      expect(await headline()).toBeNull();
    });
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
      const card = el.querySelector('.xl\\:hidden li')!;
      expect(card.querySelector('button[aria-label="Actions for old-app"]')).not.toBeNull();
    } finally {
      restore();
    }
  });
});
