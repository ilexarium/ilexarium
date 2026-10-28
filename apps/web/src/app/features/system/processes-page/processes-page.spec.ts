import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { LinuxSession, Process, ProcessesSummary, ProcessesUpdate } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { FilesApi } from '../../../core/files/files-api';
import { ProcessesApi } from '../../../core/processes/processes-api';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { stubScreenWidth } from '../../../layout/testing';
import { SudoDialog } from '../../../layout/sudo-dialog/sudo-dialog';
import { ProcessesPage } from './processes-page';

const proc = (change: Partial<Process>): Process => ({
  pid: 4312,
  startTicks: '5000',
  name: 'python3',
  command: 'python3 train.py --epochs=50',
  uid: 1000,
  user: 'anna',
  state: 'running',
  cpuPercent: 148,
  cpuSeconds: 247.31,
  priority: 20,
  nice: 0,
  memoryBytes: 2e9,
  virtualBytes: 6e9,
  sharedBytes: 5e7,
  memoryPercent: 25,
  startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  kernel: false,
  system: false,
  container: null,
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
  container: { name: 'immich-server', app: 'immich' },
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
});
const SSHD = proc({
  pid: 800,
  startTicks: '200',
  name: 'sshd',
  command: 'sshd: /usr/sbin/sshd -D',
  uid: 0,
  user: 'root',
  state: 'sleeping',
  cpuPercent: 0.1,
  memoryBytes: 5e6,
  system: true,
});
const STUCK = proc({
  pid: 900,
  startTicks: '9',
  name: 'rsync',
  command: 'rsync',
  state: 'waiting',
  cpuPercent: 1,
});

const SUMMARY: ProcessesSummary = {
  cores: 4,
  cpuPercent: 40,
  load: [3.2, 2, 1],
  memory: { totalBytes: 8e9, availableBytes: 2e9, swapTotalBytes: 2e9, swapUsedBytes: 1.5e9 },
  pressure: { cpu: 4, memory: 0, io: 12.5 },
};
const ANNA: LinuxSession = { username: 'anna', home: '/home/anna', uid: 1000, sudoUntil: null };

const update = (processes: Process[], partial = false): ProcessesUpdate => ({
  processes,
  summary: SUMMARY,
  partial,
});
const httpError = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { message: 'x', code } });
const alertDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const fill = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
};
const buttonIn = (root: HTMLElement | null, text: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) =>
    b.textContent!.includes(text),
  )!;

async function render(linux: LinuxSession | null = ANNA, { prompt = false } = {}) {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const api = { signal: vi.fn(() => of(undefined)) };
  const filesApi = {
    session: vi.fn(() => of({ session: linux })),
    signIn: vi.fn(() => of(ANNA)),
    unlockSudo: vi.fn(() =>
      of({ ...ANNA, sudoUntil: new Date(Date.now() + 15 * 60_000).toISOString() }),
    ),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: ProcessesApi, useValue: api },
      { provide: FilesApi, useValue: filesApi },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const fixture = TestBed.createComponent(ProcessesPage);
  // The shell's prompt for the account's sudo password.
  if (prompt) TestBed.createComponent(SudoDialog);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const push = async (data: ProcessesUpdate) => {
    socket.receive({ event: 'processes:update', data });
    await fixture.whenStable();
  };
  /** The table's rows, by PID. */
  const pids = () =>
    [...el.querySelectorAll('tbody tr')].map((row) => Number(row.querySelector('td')!.textContent));
  const button = (text: string) => buttonIn(el, text);
  const menu = async (name: string, pid: number, item: string) => {
    el.querySelector<HTMLButtonElement>(
      `button[aria-label="Actions for ${name} (PID ${pid})"]`,
    )!.click();
    await fixture.whenStable();
    [...document.querySelectorAll<HTMLElement>('[hlmDropdownMenuItem], [role="menuitem"]')]
      .find((b) => b.textContent!.includes(item))!
      .click();
    await fixture.whenStable();
  };
  return { fixture, el, api, filesApi, socket, push, pids, button, menu };
}

describe('ProcessesPage', () => {
  let restoreScreen: () => void;
  beforeEach(() => (restoreScreen = stubScreenWidth(1440)));
  afterEach(() => {
    restoreScreen();
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

  it('shows htop’s columns: per-core CPU, memory, TIME+, the state letter', async () => {
    const { el, push } = await render();
    await push(update([PYTHON]));
    const headers = [...el.querySelectorAll('thead th')].map((th) => th.textContent!.trim());
    expect(headers.slice(0, 12)).toEqual([
      'PID',
      'USER',
      'PRI',
      'NI',
      'VIRT',
      'RES',
      'SHR',
      'S',
      'CPU%',
      'MEM%',
      'TIME+',
      'Command',
    ]);
    const cells = [...el.querySelectorAll('tbody tr td')].map((td) => td.textContent!.trim());
    expect(cells.slice(0, 11)).toEqual([
      '4312',
      'anna',
      '20',
      '0',
      '6.0 GB',
      '2.0 GB',
      '50 MB',
      'R',
      '148.0',
      '25.0',
      '4:07.31',
    ]);
    expect(cells[11]).toContain('python3 train.py --epochs=50');
  });

  it('the header: CPU with the load in words, memory and swap, waiting, where it goes', async () => {
    const { el, push } = await render();
    await push(update([PYTHON, IMMICH, SSHD]));
    const header = el.querySelector('laris-process-summary')!.textContent!;
    expect(header).toContain('Load 3.20 on 4 cores');
    expect(el.querySelector('[data-load-level]')!.textContent).toBe('busy');
    expect(header).toContain('6.0 GB of 8.0 GB in use');
    expect(header).toContain('Swap: 1.5 GB of 2.0 GB in use');
    expect(header).toContain('For the disk');
    expect(header).toContain('13%');
    // By CPU, as a share of the machine (per-core sum over 4 cores): anna 37%, immich 3%.
    const groups = [...el.querySelectorAll('laris-process-summary li')].map((li) =>
      li.textContent!.replace(/\s+/g, ' ').trim(),
    );
    expect(groups[0]).toMatch(/^anna\s*37%/);
    expect(groups[1]).toMatch(/^immich\s*3%/);
  });

  it('filters by a group of "Where it goes", and by "Needs attention"', async () => {
    const { el, push, pids, fixture, button } = await render();
    await push(update([PYTHON, IMMICH, STUCK]));
    expect(pids()).toEqual([4312, 2201, 900]);
    el.querySelector<HTMLButtonElement>('button[aria-label="Show only immich"]')!.click();
    await fixture.whenStable();
    expect(pids()).toEqual([2201]);
    expect(el.textContent).toContain('only immich');
    button('Show all')!.click();
    await fixture.whenStable();
    expect(pids()).toEqual([4312, 2201, 900]);

    expect(el.textContent).toContain('1 waiting for the disk');
    buttonIn(el, 'Needs attention').click();
    await fixture.whenStable();
    expect(pids()).toEqual([900]);
  });

  it('sorts by its column headers, again for the other direction', async () => {
    const { el, push, pids, fixture } = await render();
    await push(update([IMMICH, PYTHON, SSHD]));
    const header = (name: string) =>
      el.querySelector<HTMLButtonElement>(`button[aria-label="Sort by ${name}"]`)!;
    expect(pids()).toEqual([4312, 2201]); // CPU, busiest first; system processes hidden
    header('Process ID').click();
    await fixture.whenStable();
    expect(pids()).toEqual([2201, 4312]);
    expect(header('Process ID').closest('th')!.getAttribute('aria-sort')).toBe('ascending');
    header('Process ID').click();
    await fixture.whenStable();
    expect(pids()).toEqual([4312, 2201]);
    expect(header('Process ID').closest('th')!.getAttribute('aria-sort')).toBe('descending');
  });

  it('searches the name, command line and user; system processes on request', async () => {
    const { el, push, pids, fixture } = await render();
    await push(update([SSHD, IMMICH, KTHREAD, PYTHON]));
    expect(pids()).toEqual([4312, 2201]);
    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    fill(search, 'train');
    await fixture.whenStable();
    expect(pids()).toEqual([4312]);
    fill(search, 'ROOT');
    await fixture.whenStable();
    expect(pids()).toEqual([2201]);
    fill(search, '');
    el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await fixture.whenStable();
    expect(pids()).toEqual([4312, 2201, 800, 2]);
  });

  it('htop’s keys in the table: move the selection, k ends it, Space pauses', async () => {
    const { el, push, fixture } = await render();
    await push(update([PYTHON, IMMICH]));
    const table = el.querySelector<HTMLElement>('[role="region"]')!;
    const key = async (k: string) => {
      table.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      await fixture.whenStable();
    };
    await key('ArrowDown');
    await key('ArrowDown');
    expect(el.querySelector('tr[aria-selected="true"] td')!.textContent).toBe('2201');
    await key('ArrowUp');
    await key('k');
    expect(alertDialog()!.textContent).toContain('End python3?');
    document.querySelector<HTMLButtonElement>('[role="alertdialog"] button')!.click(); // Cancel
    await fixture.whenStable();
    await key(' ');
    expect(el.textContent).toContain('Paused');
    // A focused header button keeps its own keys.
    const header = el.querySelector<HTMLButtonElement>('button[aria-label="Sort by CPU time"]')!;
    header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await fixture.whenStable();
    expect(el.textContent).toContain('Paused');
  });

  it('ends the account’s own process (TERM), then forces it if it still runs — both manual', async () => {
    const { el, api, push, fixture, menu } = await render();
    await push(update([PYTHON]));
    const success = vi.spyOn(toast, 'success');
    await menu('python3', 4312, 'End…');
    expect(alertDialog()!.textContent).toContain('End python3?');
    expect(alertDialog()!.textContent).toContain('PID 4312 · user anna');
    buttonIn(alertDialog(), 'End process').click();
    await vi.waitFor(() =>
      expect(api.signal).toHaveBeenCalledWith({ pid: 4312, startTicks: '5000', signal: 'TERM' }),
    );
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('python3 was asked to stop'));
    await push(update([PYTHON]));
    expect(el.querySelector('tbody')!.textContent).toContain('still running');

    await menu('python3', 4312, 'Force end…');
    expect(alertDialog()!.textContent).toContain('Force python3 to end?');
    buttonIn(alertDialog(), 'Force end').click();
    await vi.waitFor(() =>
      expect(api.signal).toHaveBeenLastCalledWith({
        pid: 4312,
        startTicks: '5000',
        signal: 'KILL',
      }),
    );
    expect(api.signal).toHaveBeenCalledTimes(2);
  });

  it('another’s process: through the account’s sudo — its password asked (a wrong one shown), then ended', async () => {
    const { api, filesApi, push, fixture, menu } = await render(ANNA, { prompt: true });
    await push(update([IMMICH]));
    await menu('node', 2201, 'End as administrator…');
    expect(alertDialog()!.textContent).toContain('End node?');
    expect(alertDialog()!.textContent).toContain(
      'It isn’t a process of anna, so it’s ended through that account’s sudo.',
    );
    buttonIn(alertDialog(), 'End process').click();
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Administrator rights'));
    expect(dialog()!.textContent).toContain('This needs the sudo of anna.');
    expect(api.signal).not.toHaveBeenCalled();

    filesApi.unlockSudo.mockReturnValueOnce(
      throwError(() => httpError(403, 'sudo_password_wrong')),
    );
    fill(dialog()!.querySelector<HTMLInputElement>('#sudo-password')!, 'wrong');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() =>
      expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain(
        'sudo didn’t accept this password.',
      ),
    );
    fill(dialog()!.querySelector<HTMLInputElement>('#sudo-password')!, 'right');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() =>
      expect(api.signal).toHaveBeenCalledWith({ pid: 2201, startTicks: '3000', signal: 'TERM' }),
    );
    expect(filesApi.unlockSudo).toHaveBeenLastCalledWith({ password: 'right' });
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await fixture.whenStable();
  });

  it('another’s process: the password prompt cancelled, nothing is sent', async () => {
    const { api, push, menu } = await render(ANNA, { prompt: true });
    await push(update([IMMICH]));
    await menu('node', 2201, 'End as administrator…');
    buttonIn(alertDialog(), 'End process').click();
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Administrator rights'));
    buttonIn(dialog(), 'Cancel').click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(api.signal).not.toHaveBeenCalled();
  });

  it('without a Linux session: signing in first, then the confirmation goes on', async () => {
    const { api, filesApi, push, fixture, menu } = await render(null);
    await push(update([PYTHON]));
    await menu('python3', 4312, 'End…');
    expect(dialog()!.textContent).toContain('Sign in to end processes');
    const [user, pass] = dialog()!.querySelectorAll<HTMLInputElement>('input');
    fill(user, 'anna');
    fill(pass, 'secret');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() =>
      expect(filesApi.signIn).toHaveBeenCalledWith({ username: 'anna', password: 'secret' }),
    );
    await vi.waitFor(() => expect(alertDialog()?.textContent).toContain('End python3?'));
    buttonIn(alertDialog(), 'End process').click();
    await vi.waitFor(() => expect(api.signal).toHaveBeenCalled());
    await fixture.whenStable();
  });

  it('reports Linux’s refusal in a toast', async () => {
    const { api, push, menu } = await render();
    await push(update([PYTHON]));
    api.signal.mockReturnValue(throwError(() => httpError(403, 'process_not_permitted')));
    const error = vi.spyOn(toast, 'error');
    await menu('python3', 4312, 'End…');
    buttonIn(alertDialog(), 'End process').click();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("The process couldn't be ended", {
        description: 'Linux didn’t allow this account to end that process.',
      }),
    );
  });

  it('never offers ending PID 1 or a kernel thread', async () => {
    const { el, push, fixture } = await render();
    await push(update([proc({ pid: 1, startTicks: '1', name: 'systemd', system: true }), KTHREAD]));
    el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await fixture.whenStable();
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(el.querySelector('button[aria-label^="Actions for"]')).toBeNull();
  });

  it('says so when the list is incomplete (hidepid)', async () => {
    const { el, push } = await render();
    await push(update([PYTHON], true));
    expect(el.textContent).toContain('the list is incomplete');
  });

  it('phones: two lines a process, a tap shows the details and the actions', async () => {
    restoreScreen();
    restoreScreen = stubScreenWidth(375);
    const { el, push, fixture } = await render();
    await push(update([PYTHON, IMMICH]));
    expect(el.querySelector('table')).toBeNull();
    const rows = el.querySelectorAll<HTMLElement>('laris-process-list ul > li');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('python3');
    expect(rows[0].textContent).toContain('anna');
    rows[1].querySelector('button')!.click();
    await fixture.whenStable();
    expect(rows[1].textContent).toContain('node /usr/src/app/server');
    const actions = [...rows[1].querySelectorAll('a, button')].map((b) => b.textContent!.trim());
    expect(actions).toEqual(
      expect.arrayContaining([
        'Go to Containers',
        'End as administrator…',
        'Force end as administrator…',
      ]),
    );
  });

  it('shows the busiest 50 at first, all on request', async () => {
    const { el, push, fixture, button } = await render();
    const many = Array.from({ length: 60 }, (_, i) =>
      proc({ pid: 5000 + i, startTicks: String(i), name: `job-${i}`, cpuPercent: 60 - i }),
    );
    await push(update(many));
    expect(el.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(el.textContent).toContain('60 processes');
    button('Show all (60)')!.click();
    await fixture.whenStable();
    expect(el.querySelectorAll('tbody tr')).toHaveLength(60);
  });
});
