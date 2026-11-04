import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { LinuxSession, PersonCheck } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { FilesApi } from '../../../core/files/files-api';
import { MachineCheckApi } from '../../../core/machine-check/machine-check-api';
import { SignInPrompt } from '../../../layout/sign-in-prompt/sign-in-prompt';
import { SudoDialog } from '../../../layout/sudo-dialog/sudo-dialog';
import { stubScreenWidth } from '../../../layout/testing';
import { MachineCheckPage } from './machine-check-page';

const ANNA: LinuxSession = { username: 'anna', home: '/home/anna', uid: 1000, sudoUntil: null };
const PASSED: PersonCheck = {
  helper: 'ok',
  userUnits: true,
  lingering: true,
  docker: 'user_units',
};
const unlocked = () => ({
  ...ANNA,
  sudoUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
});
const httpError = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { message: 'x', code } });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const buttonIn = (root: ParentNode | null, text: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) =>
    b.textContent!.includes(text),
  )!;
const fill = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

async function render(linux: LinuxSession | null = ANNA, check: PersonCheck = PASSED) {
  const auth = fakeAuthApi({ user: OWNER });
  const api = { person: vi.fn(() => of(check)) };
  let session = linux;
  const filesApi = {
    session: vi.fn(() => of({ session })),
    signIn: vi.fn(() => of((session = ANNA))),
    unlockSudo: vi.fn(() => of((session = unlocked()))),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      { provide: MachineCheckApi, useValue: api },
      { provide: FilesApi, useValue: filesApi },
    ],
  });
  await TestBed.inject(AuthStore).load();
  const fixture = TestBed.createComponent(MachineCheckPage);
  TestBed.createComponent(SignInPrompt);
  TestBed.createComponent(SudoDialog);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  /** Each row: its title with its status, its text, and its command if it has one. */
  const rows = () =>
    [...el.querySelectorAll('li')].map((li) => {
      const command = li.querySelector('code');
      return [
        li.querySelector('h2')!.textContent!.replace(/\s+/g, ' ').trim(),
        li.querySelector('p')!.textContent!.trim(),
        ...(command ? [command.textContent!.trim()] : []),
      ];
    });
  const unlock = async () => {
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Administrator rights'));
    fill(dialog()!.querySelector<HTMLInputElement>('#sudo-password')!, 'right');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  };
  return { fixture, el, api, filesApi, rows, unlock };
}

describe('MachineCheckPage', () => {
  let restoreScreen: () => void;
  beforeEach(() => (restoreScreen = stubScreenWidth(1440)));
  afterEach(() => {
    restoreScreen();
    document.querySelectorAll('.cdk-overlay-container').forEach((e) => e.remove());
  });

  it('shows the steps in order before anything runs, and runs nothing by itself', async () => {
    const { rows, api } = await render();
    expect(rows().map(([title]) => title)).toEqual([
      'Signing in to Linux — not run yet',
      'Laris’s helper — not run yet',
      'User units — not run yet',
      'sudo — not run yet',
      'Docker for apps — not run yet',
    ]);
    expect(api.person).not.toHaveBeenCalled();
  });

  it('runs the chain: the helper’s checks, then sudo unlocked through the prompt — every step passed', async () => {
    const { el, rows, api, filesApi, unlock, fixture } = await render();
    buttonIn(el, 'Check this machine').click();
    await unlock();
    await vi.waitFor(() => expect(filesApi.unlockSudo).toHaveBeenCalledWith({ password: 'right' }));
    await fixture.whenStable();
    expect(api.person).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([
      ['Signing in to Linux — passed', 'Signed in as anna.'],
      ['Laris’s helper — passed', 'It answers, as your account.'],
      ['User units — passed', 'Your account’s systemd starts units.'],
      ['sudo — passed', 'Unlocked: administrator tasks work.'],
      ['Docker for apps — information', 'Your apps run as your own units, with the docker group.'],
    ]);
    expect(buttonIn(el, 'Check again')).toBeTruthy();
  });

  it('without a Linux session: the sign-in first, then the checks', async () => {
    const { el, rows, api, filesApi, fixture } = await render(null);
    buttonIn(el, 'Check without sudo').click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    const [user, pass] = dialog()!.querySelectorAll<HTMLInputElement>('input');
    fill(user, 'anna');
    fill(pass, 'secret');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() => expect(filesApi.signIn).toHaveBeenCalled());
    await vi.waitFor(() => expect(api.person).toHaveBeenCalled());
    await fixture.whenStable();
    expect(rows()[0][0]).toBe('Signing in to Linux — passed');
    expect(rows()[3][0]).toBe('sudo — skipped');
  });

  it('a failing step says what to do; the steps after it aren’t checked', async () => {
    const { el, rows, fixture } = await render(ANNA, {
      helper: 'unavailable',
      userUnits: null,
      lingering: null,
      docker: null,
    });
    buttonIn(el, 'Check this machine').click();
    await vi.waitFor(() => expect(rows()[1][0]).toBe('Laris’s helper — failed'));
    await fixture.whenStable();
    expect(rows()[1][2]).toBe('sudo ./install.sh');
    expect(el.querySelector('code')!.getAttribute('dir')).toBe('ltr');
    expect(
      rows()
        .slice(2)
        .map(([title]) => title),
    ).toEqual(['User units — not checked', 'sudo — not checked', 'Docker for apps — not checked']);
    expect(dialog()).toBeNull();
  });

  it('no user units: the fix names lingering for the account; Docker through sudo', async () => {
    const { el, rows, fixture } = await render(ANNA, {
      helper: 'ok',
      userUnits: false,
      lingering: true,
      docker: 'system_units',
    });
    buttonIn(el, 'Check without sudo').click();
    await vi.waitFor(() => expect(rows()[2][0]).toBe('User units — failed'));
    await fixture.whenStable();
    expect(rows()[2][2]).toBe('sudo loginctl enable-linger anna');
    expect(rows()[4][2]).toBe('sudo usermod -aG docker anna');
  });

  it('user units start in the session, but lingering is off: failed, with lingering as the fix', async () => {
    const { el, rows, fixture } = await render(ANNA, { ...PASSED, lingering: false });
    buttonIn(el, 'Check without sudo').click();
    await vi.waitFor(() => expect(rows()[2][0]).toBe('User units — failed'));
    await fixture.whenStable();
    expect(rows()[2][1]).toContain('lingering is off');
    expect(rows()[2][2]).toBe('sudo loginctl enable-linger anna');
  });

  it('the sudo prompt closed: sudo not unlocked, with what to do', async () => {
    const { el, rows, fixture } = await render();
    buttonIn(el, 'Check this machine').click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    buttonIn(dialog(), 'Cancel').click();
    await vi.waitFor(() => expect(rows()[3][0]).toBe('sudo — not checked'));
    await fixture.whenStable();
    expect(rows()[3][2]).toBe('sudo usermod -aG sudo anna');
  });

  it('a request that fails: a toast, and the rest not checked', async () => {
    const { el, rows, api, fixture } = await render();
    const error = vi.spyOn(toast, 'error');
    api.person.mockReturnValueOnce(throwError(() => httpError(503, 'helper_unavailable')));
    buttonIn(el, 'Check this machine').click();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    await fixture.whenStable();
    expect(error.mock.calls[0][0]).toBe('The check couldn’t be run');
    expect(rows()[1][0]).toBe('Laris’s helper — not checked');
  });
});
