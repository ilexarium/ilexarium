import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Process, ProcessesUpdate } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { ProcessesApi } from '../../../core/processes/processes-api';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { stubScreenWidth } from '../../../layout/testing';
import { ProcessesPage } from './processes-page';

const proc = (change: Partial<Process>): Process => ({
  pid: 4312,
  startTicks: '5000',
  name: 'python3',
  command: 'python3 train.py --epochs=50',
  uid: 1000,
  user: 'anna',
  state: 'running',
  cpuPercent: 48,
  memoryBytes: 2e9,
  memoryPercent: 25,
  startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  kernel: false,
  system: false,
  container: null,
  endable: true,
  ...change,
});

const PYTHON = proc({});
const IMMICH = proc({
  pid: 2201,
  startTicks: '3000',
  name: 'node',
  command: 'node /usr/src/app/server',
  uid: 0,
  user: 'root',
  cpuPercent: 12,
  memoryBytes: 1e9,
  container: { name: 'immich-server', catalogId: 'immich' },
  endable: false,
});
const KTHREAD = proc({
  pid: 2,
  startTicks: '1',
  name: 'kthreadd',
  command: '',
  uid: 0,
  user: 'root',
  cpuPercent: 0,
  memoryBytes: 0,
  kernel: true,
  system: true,
  endable: false,
});
const SSHD = proc({
  pid: 800,
  startTicks: '200',
  name: 'sshd',
  command: 'sshd: /usr/sbin/sshd -D',
  uid: 0,
  user: 'root',
  cpuPercent: 0.1,
  memoryBytes: 5e6,
  system: true,
  endable: false,
});

const update = (processes: Process[], partial = false): ProcessesUpdate => ({ processes, partial });
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

async function render() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const api = { signal: vi.fn(async () => undefined) };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: ProcessesApi, useValue: api },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const fixture = TestBed.createComponent(ProcessesPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const push = async (data: ProcessesUpdate) => {
    socket.receive({ event: 'processes:update', data });
    await fixture.whenStable();
  };
  /** The table's rows (the cards hold the same, for smaller screens). */
  const names = () =>
    [...el.querySelectorAll('tbody [data-name]')].map((s) => s.textContent!.trim());
  const button = (text: string, root: ParentNode = el) =>
    [...root.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')].find(
      (b) => b.textContent?.trim() === text,
    );
  return { fixture, el, api, socket, push, names, button };
}

describe('ProcessesPage', () => {
  let restoreScreen: (() => void) | null = null;
  afterEach(() => {
    restoreScreen?.();
    restoreScreen = null;
    document.querySelectorAll('.cdk-overlay-container').forEach((e) => e.remove());
  });

  it('follows the processes topic, with a loading state until the first list', async () => {
    const { el, socket, fixture } = await render();
    expect(socket.sent).toContainEqual({ event: 'subscribe', data: { topic: 'processes' } });
    expect(el.querySelector('[role="status"]')!.getAttribute('aria-label')).toBe(
      'Loading processes',
    );
    fixture.destroy();
    expect(socket.sent).toContainEqual({ event: 'unsubscribe', data: { topic: 'processes' } });
  });

  it('lists processes by CPU, without system processes until asked', async () => {
    const { el, push, names, fixture } = await render();
    await push(update([SSHD, IMMICH, KTHREAD, PYTHON]));
    expect(names()).toEqual(['python3', 'node']);
    expect(el.textContent).toContain('2 processes');
    expect(el.textContent).toContain('Container immich-server');
    const toggle = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0];
    toggle.click();
    await fixture.whenStable();
    expect(names()).toEqual(['python3', 'node', 'sshd', 'kthreadd']);
    expect(el.textContent).toContain('Kernel thread');
  });

  it('searches the name, command line and user; sorts by memory, name or PID', async () => {
    const { el, push, names, fixture, button } = await render();
    await push(update([IMMICH, PYTHON]));
    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'train';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(names()).toEqual(['python3']);
    search.value = 'ROOT';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(names()).toEqual(['node']);
    search.value = 'nothing like it';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(el.textContent).toContain('No processes match.');

    search.value = '';
    search.dispatchEvent(new Event('input'));
    button('PID')!.click();
    await fixture.whenStable();
    expect(names()).toEqual(['node', 'python3']);
    expect(button('PID')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('pauses: the list stays as it was until resumed', async () => {
    const { push, names, fixture, button, el } = await render();
    await push(update([PYTHON]));
    button('Pause')!.click();
    await fixture.whenStable();
    await push(update([PYTHON, IMMICH]));
    expect(names()).toEqual(['python3']);
    expect(el.textContent).toContain('Paused');
    button('Resume')!.click();
    await fixture.whenStable();
    expect(names()).toEqual(['python3', 'node']);
  });

  it('ends a person’s process after confirming; a container’s points to the Containers page', async () => {
    const { el, api, push, fixture } = await render();
    await push(update([PYTHON, IMMICH]));
    const end = el.querySelector<HTMLButtonElement>('button[aria-label="End python3 (PID 4312)"]')!;
    expect(el.querySelector('button[aria-label^="End node"]')).toBeNull();
    expect(
      el.querySelector('a[aria-label="Stop node on the Containers page"]')!.getAttribute('href'),
    ).toBe('/containers');

    const success = vi.spyOn(toast, 'success');
    end.click();
    await fixture.whenStable();
    expect(dialog()!.textContent).toContain('End python3?');
    expect(dialog()!.textContent).toContain('PID 4312 · user anna');
    [...dialog()!.querySelectorAll('button')]
      .find((b) => b.textContent!.includes('End process'))!
      .click();
    await vi.waitFor(() =>
      expect(api.signal).toHaveBeenCalledWith({ pid: 4312, startTicks: '5000', signal: 'TERM' }),
    );
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('python3 was asked to stop'));
  });

  it('offers "Force end" when the process still runs 5 s after being asked to stop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { el, api, push, fixture } = await render();
      await push(update([PYTHON]));
      el.querySelector<HTMLButtonElement>('button[aria-label="End python3 (PID 4312)"]')!.click();
      await fixture.whenStable();
      [...dialog()!.querySelectorAll('button')]
        .find((b) => b.textContent!.includes('End process'))!
        .click();
      await vi.waitFor(() => expect(api.signal).toHaveBeenCalledTimes(1));
      await fixture.whenStable();

      vi.setSystemTime(Date.now() + 2_000);
      await push(update([PYTHON]));
      expect(el.querySelector('button[aria-label^="Force"]')).toBeNull();
      vi.setSystemTime(Date.now() + 4_000);
      await push(update([PYTHON]));
      const force = el.querySelector<HTMLButtonElement>(
        'button[aria-label="Force python3 (PID 4312) to end"]',
      )!;
      force.click();
      await fixture.whenStable();
      expect(dialog()!.textContent).toContain('Force python3 to end?');
      [...dialog()!.querySelectorAll('button')]
        .find((b) => b.textContent!.includes('Force end'))!
        .click();
      await vi.waitFor(() =>
        expect(api.signal).toHaveBeenLastCalledWith({
          pid: 4312,
          startTicks: '5000',
          signal: 'KILL',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a refusal in a toast', async () => {
    const { el, api, push, fixture } = await render();
    await push(update([PYTHON]));
    api.signal.mockRejectedValue(
      new HttpErrorResponse({ status: 404, error: { message: 'x', code: 'process_not_found' } }),
    );
    const error = vi.spyOn(toast, 'error');
    el.querySelector<HTMLButtonElement>('button[aria-label="End python3 (PID 4312)"]')!.click();
    await fixture.whenStable();
    [...dialog()!.querySelectorAll('button')]
      .find((b) => b.textContent!.includes('End process'))!
      .click();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("The process couldn't be ended", {
        description: "This process isn't running any more.",
      }),
    );
  });

  it('says so when the list is incomplete (hidepid)', async () => {
    const { el, push } = await render();
    await push(update([PYTHON], true));
    expect(el.textContent).toContain('the list is incomplete');
  });

  it('shows one card per process on smaller screens (no table), with the same details and actions', async () => {
    restoreScreen = stubScreenWidth(375);
    const { el, push } = await render();
    await push(update([PYTHON, IMMICH]));
    expect(el.querySelector('table')).toBeNull();
    const cards = el.querySelectorAll('app-process-list ul > li');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('python3');
    expect(cards[0].textContent).toContain('anna');
    expect(cards[0].querySelector('button')!.textContent!.trim()).toBe('End');
    expect(cards[1].querySelector('a')!.textContent!.trim()).toBe('Containers');
  });

  it('shows the busiest 50 at first, all on request', async () => {
    const { el, push, fixture, button } = await render();
    const many = Array.from({ length: 60 }, (_, i) =>
      proc({ pid: 5000 + i, startTicks: String(i), name: `job-${i}`, cpuPercent: 60 - i }),
    );
    await push(update(many));
    expect(el.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(el.querySelector('tbody [data-name]')!.textContent).toBe('job-0');
    expect(el.textContent).toContain('60 processes');
    button('Show all (60)')!.click();
    await fixture.whenStable();
    expect(el.querySelectorAll('tbody tr')).toHaveLength(60);
    expect(button('Show all (60)')).toBeUndefined();
  });
});
