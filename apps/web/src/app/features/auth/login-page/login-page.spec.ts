import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { SECURE_CONTEXT } from '../../../core/security/secure-context';
import { submit, textOf, typeInto } from '../../../shared/forms/testing';
import { readStored, writeStored } from '../../../core/storage/browser-storage';
import { stubLocalStorage } from '../../../layout/testing';
import { LoginPage } from './login-page';

async function render({ secure = true, query = {} as Record<string, string> } = {}) {
  const fake = fakeAuthApi();
  TestBed.configureTestingModule({
    imports: [LoginPage],
    providers: [
      provideRouter([]),
      fake.provider,
      { provide: SECURE_CONTEXT, useValue: secure },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(query) } },
      },
    ],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(LoginPage);
  await fixture.whenStable();
  return { fixture, api: fake.api, navigate, store: TestBed.inject(AuthStore) };
}

describe('LoginPage', () => {
  it('shows the HTTPS notice instead of the form on an insecure connection', async () => {
    const { fixture } = await render({ secure: false });
    expect(textOf(fixture)).toContain("This connection isn't encrypted");
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
  });

  it('says the session expired when redirected for that reason', async () => {
    expect(textOf((await render({ query: { reason: 'expired' } })).fixture)).toContain(
      'Your session expired',
    );
    TestBed.resetTestingModule();
    expect(textOf((await render()).fixture)).not.toContain('Your session expired');
  });

  it('uses autocomplete hints password managers understand', async () => {
    const { fixture } = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#username')!.getAttribute('autocomplete')).toBe('username');
    expect(el.querySelector('#password')!.getAttribute('autocomplete')).toBe('current-password');
  });

  it('keeps the username and password fields left to right in every language', async () => {
    const { fixture } = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#username')!.getAttribute('dir')).toBe('ltr');
    expect(el.querySelector('#password')!.getAttribute('dir')).toBe('ltr');
  });

  it('signs in and returns to the (safe) return URL', async () => {
    const { fixture, api, navigate, store } = await render({
      query: { returnUrl: '/settings/account' },
    });
    api.login.mockReturnValue(of({ user: OWNER }));
    typeInto(fixture, 'username', 'owner');
    typeInto(fixture, 'password', 'correct horse battery');
    await submit(fixture);
    expect(api.login).toHaveBeenCalledWith({
      username: 'owner',
      password: 'correct horse battery',
    });
    expect(store.user()).toEqual(OWNER);
    expect(navigate).toHaveBeenCalledWith('/settings/account');
  });

  it('never follows an external return URL', async () => {
    const { fixture, api, navigate } = await render({ query: { returnUrl: '//evil.example' } });
    api.login.mockReturnValue(of({ user: OWNER }));
    typeInto(fixture, 'username', 'owner');
    typeInto(fixture, 'password', 'x');
    await submit(fixture);
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('shows the server error for wrong credentials and stays put', async () => {
    const { fixture, api, navigate } = await render();
    api.login.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 401,
            error: { message: 'Invalid username or password', code: 'invalid_credentials' },
          }),
      ),
    );
    typeInto(fixture, 'username', 'owner');
    typeInto(fixture, 'password', 'wrong');
    await submit(fixture);
    expect(textOf(fixture)).toContain('Invalid username or password');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('validates on the client before calling the server', async () => {
    const { fixture, api } = await render();
    await submit(fixture);
    expect(api.login).not.toHaveBeenCalled();
    expect(textOf(fixture)).toContain('Enter your username');
    expect(textOf(fixture)).toContain('Enter your password');
  });

  it('toggles password visibility', async () => {
    const { fixture } = await render();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector<HTMLInputElement>('#password')!;
    expect(input.type).toBe('password');
    el.querySelector<HTMLButtonElement>('button[aria-label="Show passwords"]')!.click();
    await fixture.whenStable();
    expect(input.type).toBe('text');
  });

  it('after Ilexarium was restored from this browser: says so instead of "expired", until signed in', async () => {
    const storage = stubLocalStorage();
    try {
      writeStored(window, 'ilex.recovered', String(Date.now() - 31 * 60_000));
      expect(textOf((await render()).fixture)).not.toContain(
        'Ilexarium restarted after the recovery',
      );
      TestBed.resetTestingModule();
      writeStored(window, 'ilex.recovered', String(Date.now()));
      const { fixture, api } = await render({ query: { reason: 'expired' } });
      expect(textOf(fixture)).toContain('Ilexarium restarted after the recovery');
      expect(textOf(fixture)).not.toContain('Your session expired');
      api.login.mockReturnValue(of({ user: OWNER }));
      typeInto(fixture, 'username', 'owner');
      typeInto(fixture, 'password', 'correct horse battery');
      await submit(fixture);
      expect(readStored(window, 'ilex.recovered')).toBe('');
    } finally {
      storage.restore();
    }
  });
});
