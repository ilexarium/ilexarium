import { HttpErrorResponse } from '@angular/common/http';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { LinuxSignInRequest } from '@laris/shared';
import type { SignInStep } from './sign-in-dialog.model';
import { SignInDialog } from './sign-in-dialog';

/** A page's part: the step follows its session, the dialog's open state. */
@Component({
  imports: [SignInDialog],
  template: `<laris-sign-in-dialog
    title="terminal.signIn.title"
    text="terminal.signIn.text"
    [step]="step()"
    [open]="open()"
    [signIn]="signIn"
    [unlock]="withUnlock ? unlock : undefined"
    [notice]="notice()"
    (closed)="open.set(false); closings = closings + 1"
  />`,
})
class Host {
  readonly open = signal(true);
  readonly step = signal<SignInStep>('linux');
  readonly notice = signal<string | null>(null);
  withUnlock = true;
  closings = 0;
  readonly signIn = vi.fn(async (_request: LinuxSignInRequest) => this.step.set('app'));
  readonly unlock = vi.fn(async (_password: string) => undefined);
}

const refused = (field: string, code: string) =>
  new HttpErrorResponse({
    status: 400,
    error: { message: 'Validation failed', errors: [{ field, code, message: 'x' }] },
  });

async function render(withUnlock = true) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.withUnlock = withUnlock;
  await fixture.whenStable();
  const host = fixture.componentInstance;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const type = (id: string, value: string) => {
    const field = dialog()!.querySelector<HTMLInputElement>(`#${id}`)!;
    field.value = value;
    field.dispatchEvent(new Event('input'));
  };
  const submit = async () => {
    dialog()!.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await fixture.whenStable();
  };
  const signInAs = async () => {
    type('linux-username', 'anna');
    type('linux-password', 'linux');
    await submit();
  };
  return { fixture, host, dialog, type, submit, signInAs };
}

describe('SignInDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  // The first field's focus is cdk's first-tabbable, which jsdom can't tell: seen in the browser.
  it('the Linux step has its title', async () => {
    const { dialog } = await render();
    expect(dialog()!.querySelector('h2')!.textContent!.trim()).toBe('Open a terminal');
  });

  it('without unlock (Files): closes after signing in', async () => {
    const { host, signInAs, fixture, dialog } = await render(false);
    expect(dialog()!.querySelector('button[type=submit]')!.textContent!.trim()).toBe('Open');
    await signInAs();
    expect(host.signIn).toHaveBeenCalledWith({ username: 'anna', password: 'linux' });
    await vi.waitFor(() => expect(host.closings).toBe(1));
    await fixture.whenStable();
    expect(dialog()).toBeNull();
    // Nothing kept: opened again, the fields are empty.
    host.step.set('linux');
    host.open.set(true);
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(dialog()!.querySelector<HTMLInputElement>('#linux-password')!.value).toBe(''),
    );
  });

  it('with unlock (the terminal): the app password next in the same dialog, then closes', async () => {
    const { host, signInAs, type, submit, dialog } = await render();
    expect(dialog()!.querySelector('button[type=submit]')!.textContent!.trim()).toBe('Continue');
    await signInAs();
    await vi.waitFor(() => expect(dialog()!.textContent).toContain('Confirm it’s you'));
    expect(host.closings).toBe(0);
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('terminal-password'));
    type('terminal-password', 'app password');
    await submit();
    expect(host.unlock).toHaveBeenCalledWith('app password');
    await vi.waitFor(() => expect(host.closings).toBe(1));
  });

  it('a refusal shows in the dialog, which stays open', async () => {
    const { host, signInAs, fixture, dialog } = await render();
    host.signIn.mockRejectedValueOnce(refused('password', 'linux_login_refused'));
    await signInAs();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(dialog()!.querySelector('hlm-field-error, [role="alert"]')?.textContent).toBeTruthy();
    });
    expect(host.closings).toBe(0);
    expect(dialog()!.querySelector('#linux-username')).not.toBeNull();
  });

  it('back to the Linux step while open: empty fields, focused, saying why', async () => {
    const { host, fixture, type, dialog } = await render();
    host.step.set('app');
    await fixture.whenStable();
    type('terminal-password', 'app password');
    host.step.set('linux');
    host.notice.set('terminal.closed.linuxSessionEnded');
    await fixture.whenStable();
    expect(dialog()!.querySelector('[role="status"]')!.textContent).toContain(
      'The Linux session ended',
    );
    expect(dialog()!.querySelector<HTMLInputElement>('#linux-username')!.value).toBe('');
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('linux-username'));
    expect(host.closings).toBe(0);
  });

  it('a wrong app password shows on its field', async () => {
    const { host, fixture, type, submit, dialog } = await render();
    host.step.set('app');
    await fixture.whenStable();
    host.unlock.mockRejectedValueOnce(refused('password', 'wrong_password'));
    type('terminal-password', 'nope');
    await submit();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(dialog()!.querySelector('hlm-field-error')?.textContent).toBeTruthy();
    });
    expect(host.closings).toBe(0);
  });

  it('Cancel closes it; opened again, the fields are empty', async () => {
    const { host, fixture, type, dialog } = await render();
    type('linux-username', 'anna');
    [...dialog()!.querySelectorAll('button')]
      .find((b) => b.textContent!.includes('Cancel'))!
      .click();
    await vi.waitFor(() => expect(host.closings).toBe(1));
    host.open.set(true);
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(dialog()!.querySelector<HTMLInputElement>('#linux-username')!.value).toBe(''),
    );
  });

  it('while signing in: Cancel and the X are off', async () => {
    const { host, type, submit, dialog } = await render();
    host.signIn.mockReturnValueOnce(new Promise(() => undefined));
    type('linux-username', 'anna');
    type('linux-password', 'linux');
    await submit();
    const cancel = [...dialog()!.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Cancel'),
    )!;
    expect(cancel.disabled).toBe(true);
    expect(dialog()!.querySelector('[hlmDialogClose]')).toBeNull();
  });
});
