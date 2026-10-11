import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { submit, textOf, typeInto } from '../../../shared/forms/testing';
import { AccountPage } from './account-page';

const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('@spartan-ng/brain/sonner', async (original) => ({
  ...(await original<object>()),
  toast: { success: toastSuccess },
}));

async function render() {
  const fake = fakeAuthApi({ user: OWNER });
  TestBed.configureTestingModule({
    imports: [AccountPage],
    providers: [provideRouter([]), fake.provider],
  });
  await TestBed.inject(AuthStore).load();
  const fixture = TestBed.createComponent(AccountPage);
  await fixture.whenStable();
  return { fixture, api: fake.api };
}

function fill(
  fixture: Parameters<typeof typeInto>[0],
  current: string,
  next: string,
  confirm = next,
) {
  typeInto(fixture, 'currentPassword', current);
  typeInto(fixture, 'newPassword', next);
  typeInto(fixture, 'confirmNewPassword', confirm);
}

describe('AccountPage', () => {
  beforeEach(() => toastSuccess.mockClear());

  it('includes the username for password managers', async () => {
    const { fixture } = await render();
    const hidden = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input[autocomplete=username]',
    )!;
    expect(hidden.value).toBe('owner');
  });

  it('changes the password, confirms with a toast and clears the form', async () => {
    const { fixture, api } = await render();
    api.changePassword.mockResolvedValue(null);
    fill(fixture, 'old password here', 'brand new password');
    await submit(fixture);
    expect(api.changePassword).toHaveBeenCalledWith({
      currentPassword: 'old password here',
      newPassword: 'brand new password',
    });
    expect(toastSuccess).toHaveBeenCalledWith('Password changed', expect.any(Object));
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLInputElement>('#newPassword')!.value).toBe('');
  });

  it('shows a wrong current password on that field', async () => {
    const { fixture, api } = await render();
    api.changePassword.mockRejectedValue(
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
    );
    fill(fixture, 'wrong', 'brand new password');
    await submit(fixture);
    expect(textOf(fixture)).toContain('Current password is incorrect');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('applies the choosing rules to the new password', async () => {
    const { fixture, api } = await render();
    fill(fixture, 'old', 'short');
    await submit(fixture);
    expect(api.changePassword).not.toHaveBeenCalled();
    const errors = [...(fixture.nativeElement as HTMLElement).querySelectorAll('hlm-field-error')]
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    expect(errors).toContain('At least 12 characters');
  });
});
