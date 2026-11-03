import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type {
  JournalBootsResponse,
  JournalLine,
  JournalResponse,
  LinuxSession,
} from '@laris/shared';
import { of, Subject, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { FilesApi } from '../../../core/files/files-api';
import { SystemJournalApi } from '../../../core/system-journal/system-journal-api';
import type { JournalRequest } from '../../../core/system-journal/system-journal.model';
import { SystemServicesApi } from '../../../core/system-services/system-services-api';
import { SignInPrompt } from '../../../layout/sign-in-prompt/sign-in-prompt';
import { SudoDialog } from '../../../layout/sudo-dialog/sudo-dialog';
import { stubScreenWidth } from '../../../layout/testing';
import { JournalPage } from './journal-page';

const line = (i: number, change: Partial<JournalLine> = {}): JournalLine => ({
  cursor: `c${i}`,
  at: new Date(Date.UTC(2026, 10, 3, 10, 0, i)).toISOString(),
  priority: 6,
  unit: 'nginx.service',
  identifier: 'nginx',
  pid: 452,
  text: `line ${i}`,
  ...change,
});
const answer = (lines: JournalLine[], change: Partial<JournalResponse> = {}): JournalResponse => ({
  lines,
  more: false,
  access: 'all',
  ...change,
});
const BOOTS: JournalBootsResponse = {
  boots: [
    {
      id: 'b'.repeat(32),
      offset: 0,
      first: '2026-11-03T08:00:00.000Z',
      last: '2026-11-03T10:00:00.000Z',
    },
    {
      id: 'a'.repeat(32),
      offset: -1,
      first: '2026-11-01T08:00:00.000Z',
      last: '2026-11-02T08:00:00.000Z',
    },
  ],
  access: 'all',
};

const ANNA: LinuxSession = { username: 'anna', home: '/home/anna', uid: 1000, sudoUntil: null };
const httpError = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { message: 'x', code } });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const fill = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

async function render(
  options: { first?: JournalResponse; linux?: LinuxSession | null; url?: string } = {},
) {
  const auth = fakeAuthApi({ user: OWNER });
  const api = {
    read: vi.fn((_request: JournalRequest) => of(answer([]))),
    boots: vi.fn((_administrator: boolean) => of(BOOTS)),
  };
  api.read.mockReturnValueOnce(of(options.first ?? answer([line(1), line(2), line(3)])));
  const servicesApi = {
    list: vi.fn(() =>
      of({
        services: [{ name: 'nginx.service' }, { name: 'ssh.service' }],
        truncated: false,
      }),
    ),
  };
  let session = options.linux === undefined ? ANNA : options.linux;
  const filesApi = {
    session: vi.fn(() => of({ session })),
    signIn: vi.fn(() => of((session = ANNA))),
    unlockSudo: vi.fn(() =>
      of({ ...ANNA, sudoUntil: new Date(Date.now() + 15 * 60_000).toISOString() }),
    ),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'system/logs', component: JournalPage }]),
      auth.provider,
      { provide: SystemJournalApi, useValue: api },
      { provide: SystemServicesApi, useValue: servicesApi },
      { provide: FilesApi, useValue: filesApi },
    ],
  });
  await TestBed.inject(AuthStore).load();
  await TestBed.inject(Router).navigateByUrl(options.url ?? '/system/logs');
  const fixture = TestBed.createComponent(JournalPage);
  TestBed.createComponent(SignInPrompt);
  TestBed.createComponent(SudoDialog);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const texts = () =>
    [...el.querySelectorAll('ol[aria-label="Log lines"] li')]
      .map((li) => li.textContent!.trim())
      .filter((text) => !text.startsWith('Load older'));
  const select = (name: string) =>
    el.querySelector<HTMLSelectElement>(`select[data-filter="${name}"]`)!;
  const choose = async (name: string, value: string) => {
    select(name).value = value;
    select(name).dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };
  const button = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent!.includes(text),
    );
  return { fixture, el, api, filesApi, texts, select, choose, button };
}

describe('JournalPage', () => {
  let restoreScreen: () => void;
  beforeEach(() => (restoreScreen = stubScreenWidth(1440)));
  afterEach(() => {
    restoreScreen();
    vi.useRealTimers();
    document.querySelectorAll('.cdk-overlay-container').forEach((e) => e.remove());
  });

  it('shows this boot’s lines with who wrote them; warnings and errors with a word', async () => {
    const { texts, api } = await render({
      first: answer([
        line(1, { priority: 3, text: 'crashed' }),
        line(2, { priority: 4, identifier: null, pid: null, text: 'slow' }),
        line(3),
      ]),
    });
    expect(api.read).toHaveBeenCalledWith({
      unit: null,
      priority: 'info',
      boot: null,
      administrator: false,
    });
    const [first, second, third] = texts();
    expect(first).toContain('error');
    expect(first).toContain('nginx[452]');
    expect(first).toContain('crashed');
    expect(second).toContain('warning');
    expect(second).toContain('nginx.service');
    expect(third).not.toContain('error');
    expect(third).not.toContain('warning');
  });

  it('asks for what’s newer every 2 s, after the last line; more at once when there’s more', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api, texts, fixture } = await render();
    api.read
      .mockReturnValueOnce(of(answer([line(4)], { more: true })))
      .mockReturnValueOnce(of(answer([line(5)])));
    vi.advanceTimersByTime(2000);
    await vi.waitFor(() => expect(api.read).toHaveBeenCalledTimes(3));
    expect(api.read.mock.calls[1]![0]).toMatchObject({ after: 'c3' });
    expect(api.read.mock.calls[2]![0]).toMatchObject({ after: 'c4' });
    await fixture.whenStable();
    expect(texts().map((t) => /line \d+$/.exec(t)?.[0])).toEqual([
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
    ]);
  });

  it('loads older lines before the first one, while there are more', async () => {
    const { api, button, texts, fixture } = await render({
      first: answer([line(10), line(11)], { more: true }),
    });
    api.read.mockReturnValueOnce(of(answer([line(8), line(9)], { more: false })));
    button('Load older lines')!.click();
    await fixture.whenStable();
    expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'c10' }));
    expect(texts().map((t) => /line \d+$/.exec(t)?.[0])).toEqual([
      'line 8',
      'line 9',
      'line 10',
      'line 11',
    ]);
    expect(button('Load older lines')).toBeUndefined();
  });

  it('filters by service, priority and boot — each read anew; ?unit= chooses the service', async () => {
    const { api, choose, select, fixture } = await render({ url: '/system/logs?unit=ssh.service' });
    expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ unit: 'ssh.service' }));
    expect(select('unit').value).toBe('ssh.service');
    await choose('priority', 'error');
    expect(api.read).toHaveBeenLastCalledWith(
      expect.objectContaining({ unit: 'ssh.service', priority: 'error' }),
    );
    await choose('boot', 'a'.repeat(32));
    expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ boot: 'a'.repeat(32) }));
    expect([...select('boot').options].map((o) => o.textContent!.trim())[1]).toMatch(
      /^Previous boot \(.+ – .+\)$/,
    );
    await choose('unit', '');
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ unit: null })),
    );
    expect(TestBed.inject(Router).url).toBe('/system/logs');
  });

  it('only its own lines: offers reading as administrator, through sudo', async () => {
    const { el, api, button, filesApi, fixture } = await render({
      first: answer([line(1)], { access: 'own' }),
    });
    expect(el.querySelector('[data-notice="own"]')!.textContent).toContain(
      'Only your own messages',
    );
    api.boots.mockReturnValueOnce(throwError(() => httpError(403, 'sudo_required')));
    api.read.mockReturnValueOnce(of(answer([line(1), line(2)])));
    button('Read as administrator')!.click();
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Administrator rights'));
    fill(dialog()!.querySelector<HTMLInputElement>('#sudo-password')!, 'right');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() =>
      expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ administrator: true })),
    );
    expect(filesApi.unlockSudo).toHaveBeenCalledWith({ password: 'right' });
    await fixture.whenStable();
    expect(el.querySelector('[data-notice="own"]')).toBeNull();
  });

  it('as administrator, following stops when sudo locks, and goes on once unlocked', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { el, api, button, fixture } = await render({
      first: answer([line(1)], { access: 'own' }),
    });
    api.read.mockReturnValueOnce(of(answer([line(1)])));
    button('Read as administrator')!.click();
    await vi.waitFor(() =>
      expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ administrator: true })),
    );
    api.read.mockReturnValueOnce(throwError(() => httpError(403, 'sudo_required')));
    vi.advanceTimersByTime(2000);
    await fixture.whenStable();
    expect(el.querySelector('[data-notice="stopped"]')!.textContent).toContain('Following paused');
    const calls = api.read.mock.calls.length;
    vi.advanceTimersByTime(4000);
    expect(api.read.mock.calls.length).toBe(calls);
    button('Follow again')!.click();
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Administrator rights'));
    fill(dialog()!.querySelector<HTMLInputElement>('#sudo-password')!, 'right');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() => expect(el.querySelector('[data-notice="stopped"]')).toBeNull());
    vi.advanceTimersByTime(2000);
    expect(api.read.mock.calls.length).toBe(calls + 1);
  });

  it('as administrator, a filter changed after sudo locked asks to unlock, then reads', async () => {
    const { el, api, button, choose, fixture } = await render({
      first: answer([line(1)], { access: 'own' }),
    });
    api.read.mockReturnValueOnce(of(answer([line(1)])));
    button('Read as administrator')!.click();
    await vi.waitFor(() =>
      expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ administrator: true })),
    );
    api.read.mockReturnValueOnce(throwError(() => httpError(403, 'sudo_required')));
    await choose('priority', 'error');
    expect(el.querySelector('[data-notice="stopped"]')).not.toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    api.read.mockReturnValueOnce(of(answer([line(7, { priority: 3 })])));
    button('Follow again')!.click();
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Administrator rights'));
    fill(dialog()!.querySelector<HTMLInputElement>('#sudo-password')!, 'right');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() => expect(el.textContent).toContain('line 7'));
    await fixture.whenStable();
    expect(api.read).toHaveBeenLastCalledWith(
      expect.objectContaining({ priority: 'error', administrator: true }),
    );
  });

  it('older lines asked for the filters before: dropped, and “Load older” works again', async () => {
    const { api, button, choose, fixture } = await render({
      first: answer([line(10)], { more: true }),
    });
    const pending = new Subject<JournalResponse>();
    api.read.mockReturnValueOnce(pending);
    button('Load older lines')!.click();
    await fixture.whenStable();
    expect(button('Loading older lines')!.disabled).toBe(true);
    api.read.mockReturnValueOnce(of(answer([line(20)], { more: true })));
    await choose('priority', 'error');
    pending.error(httpError(503, 'journal_unavailable'));
    await fixture.whenStable();
    expect(button('Load older lines')!.disabled).toBe(false);
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });

  it('an empty view filled by a poll offers the older lines it couldn’t hold', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api, button, fixture } = await render({ first: answer([]) });
    expect(button('Load older lines')).toBeUndefined();
    api.read.mockReturnValueOnce(of(answer([line(1), line(2)], { more: true })));
    vi.advanceTimersByTime(2000);
    await fixture.whenStable();
    expect(api.read.mock.calls[1]![0]).not.toHaveProperty('after');
    expect(button('Load older lines')).toBeDefined();
  });

  it('without a Linux session: asks for the sign-in, then reads', async () => {
    const { el, api, button } = await render({ linux: null });
    expect(el.textContent).toContain('Sign in as a Linux user');
    expect(api.read).not.toHaveBeenCalled();
    button('Sign in')!.click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    fill(dialog()!.querySelector<HTMLInputElement>('input[autocomplete="username"]')!, 'anna');
    fill(dialog()!.querySelector<HTMLInputElement>('input[type="password"]')!, 'pw');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() => expect(api.read).toHaveBeenCalled());
  });

  it('says so when the journal can’t be read, with a way to try again', async () => {
    const { el, api, button, fixture } = await render({ first: answer([]) });
    expect(el.textContent).toContain('No lines');
    api.read.mockReturnValueOnce(throwError(() => httpError(503, 'journal_unavailable')));
    TestBed.inject(Router).navigateByUrl('/system/logs?unit=nginx.service');
    await vi.waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('can’t be read'),
    );
    api.read.mockReturnValueOnce(of(answer([line(1)])));
    button('Try again')!.click();
    await fixture.whenStable();
    expect(el.textContent).toContain('line 1');
  });

  it('phones: the filters fold behind a button', async () => {
    restoreScreen();
    restoreScreen = stubScreenWidth(375);
    const { el, button, fixture } = await render();
    const filters = el.querySelector<HTMLElement>('#journal-filters')!;
    expect(filters.classList).toContain('hidden');
    const toggle = button('Filters')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await fixture.whenStable();
    expect(filters.classList).toContain('flex');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});
