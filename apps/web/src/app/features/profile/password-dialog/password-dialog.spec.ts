import { HttpErrorResponse } from '@angular/common/http';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { ProfilePageStore } from '../profile-page/profile-page-store';
import { PasswordDialog } from './password-dialog';

/** The profile page's part: its store, and the dialog's open state. */
@Component({
  imports: [PasswordDialog],
  providers: [ProfilePageStore],
  template: `<laris-password-dialog
    [open]="open()"
    (closed)="open.set(false); closings = closings + 1"
  />`,
})
class Host {
  readonly open = signal(true);
  closings = 0;
}

async function render() {
  const fake = fakeAuthApi({ user: OWNER });
  TestBed.configureTestingModule({ providers: [provideRouter([]), fake.provider] });
  await TestBed.inject(AuthStore).load();
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  const field = (id: string) => dialog().querySelector<HTMLInputElement>(`#${id}`)!;
  const type = (id: string, value: string) => {
    field(id).value = value;
    field(id).dispatchEvent(new Event('input'));
  };
  const fill = (current: string, next: string, confirm = next) => {
    type('currentPassword', current);
    type('newPassword', next);
    type('confirmNewPassword', confirm);
  };
  const submit = async () => {
    dialog().querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await fixture.whenStable();
  };
  return { fixture, api: fake.api, dialog, field, fill, submit };
}

describe('PasswordDialog', () => {
  let toastSuccess: ReturnType<typeof vi.spyOn>;
  beforeEach(() => (toastSuccess = vi.spyOn(toast, 'success')));
  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  it('is titled "Change password" and includes the username for password managers', async () => {
    const { dialog } = await render();
    expect(dialog().querySelector('h2')!.textContent!.trim()).toBe('Change password');
    expect(dialog().querySelector<HTMLInputElement>('input[autocomplete=username]')!.value).toBe(
      'owner',
    );
  });

  it('changes the password, confirms with a toast and closes', async () => {
    const { fixture, api, fill, submit } = await render();
    api.changePassword.mockReturnValue(of(null));
    fill('old password here', 'brand new password');
    await submit();
    expect(api.changePassword).toHaveBeenCalledWith({
      currentPassword: 'old password here',
      newPassword: 'brand new password',
    });
    expect(toastSuccess).toHaveBeenCalledWith('Password changed', expect.any(Object));
    expect(fixture.componentInstance.closings).toBe(1);
  });

  it('shows a wrong current password on that field and stays open', async () => {
    const { fixture, api, dialog, fill, submit } = await render();
    api.changePassword.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: {
              message: 'Validation failed',
              errors: [
                {
                  field: 'currentPassword',
                  code: 'wrong_password',
                  message: 'Current password is incorrect',
                },
              ],
            },
          }),
      ),
    );
    fill('wrong', 'brand new password');
    await submit();
    expect(dialog().textContent).toContain('Current password is incorrect');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(fixture.componentInstance.closings).toBe(0);
  });

  it('applies the choosing rules to the new password', async () => {
    const { api, dialog, fill, submit } = await render();
    fill('old', 'short');
    await submit();
    expect(api.changePassword).not.toHaveBeenCalled();
    const errors = [...dialog().querySelectorAll('hlm-field-error')].map((el) =>
      el.textContent?.trim(),
    );
    expect(errors).toContain('At least 12 characters');
  });

  it('starts empty each time it opens', async () => {
    const { fixture, field, fill } = await render();
    fill('old password here', 'brand new password');
    fixture.componentInstance.open.set(false);
    await fixture.whenStable();
    fixture.componentInstance.open.set(true);
    await fixture.whenStable();
    expect(field('currentPassword').value).toBe('');
    expect(field('newPassword').value).toBe('');
  });

  it('closes without changing anything on Cancel', async () => {
    const { fixture, api, dialog } = await render();
    [...dialog().querySelectorAll('button')]
      .find((b) => b.textContent!.trim() === 'Cancel')!
      .click();
    await fixture.whenStable();
    expect(api.changePassword).not.toHaveBeenCalled();
    expect(fixture.componentInstance.closings).toBe(1);
  });
});
