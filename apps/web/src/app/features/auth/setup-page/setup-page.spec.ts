import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { SECURE_CONTEXT } from '../../../core/security/secure-context';
import { submit, textOf, typeInto } from '../../../shared/forms/testing';
import { SetupPage } from './setup-page';

async function render({ secure = true, url = '/setup' } = {}) {
  history.replaceState(null, '', url);
  const fake = fakeAuthApi({ needsSetup: true });
  TestBed.configureTestingModule({
    imports: [SetupPage],
    providers: [provideRouter([]), fake.provider, { provide: SECURE_CONTEXT, useValue: secure }],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(SetupPage);
  await fixture.whenStable();
  return { fixture, api: fake.api, navigate, store: TestBed.inject(AuthStore) };
}

const input = (fixture: { nativeElement: HTMLElement }, id: string) =>
  fixture.nativeElement.querySelector<HTMLInputElement>(`#${id}`)!;

describe('SetupPage', () => {
  it('prefills the code from #token=… and removes it from the address bar', async () => {
    const { fixture } = await render({ url: '/setup#token=K7QD-9F2M-ABCD' });
    expect(input(fixture, 'setupToken').value).toBe('K7QD-9F2M-ABCD');
    expect(location.hash).toBe('');
    expect(location.pathname).toBe('/setup');
  });

  it('starts empty without a fragment', async () => {
    const { fixture } = await render();
    expect(input(fixture, 'setupToken').value).toBe('');
  });

  it('shows the HTTPS notice instead of the form on an insecure connection', async () => {
    const { fixture } = await render({ secure: false });
    expect(textOf(fixture)).toContain("This connection isn't encrypted");
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
  });

  it('creates the account (without sending the confirmation) and goes home', async () => {
    const { fixture, api, navigate, store } = await render({ url: '/setup#token=K7QD-9F2M' });
    api.setup.mockReturnValue(of({ user: OWNER }));
    typeInto(fixture, 'username', 'owner');
    typeInto(fixture, 'password', 'correct horse battery');
    typeInto(fixture, 'confirmPassword', 'correct horse battery');
    await submit(fixture);
    expect(api.setup).toHaveBeenCalledWith({
      setupToken: 'K7QD-9F2M',
      username: 'owner',
      password: 'correct horse battery',
    });
    expect(store.user()).toEqual(OWNER);
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('reports a confirmation mismatch on the confirmation field', async () => {
    const { fixture, api } = await render({ url: '/setup#token=K7QD-9F2M' });
    typeInto(fixture, 'username', 'owner');
    typeInto(fixture, 'password', 'correct horse battery');
    typeInto(fixture, 'confirmPassword', 'something else entirely');
    await submit(fixture);
    expect(api.setup).not.toHaveBeenCalled();
    expect(textOf(fixture)).toContain('Passwords do not match');
  });

  it('shows the server error for a wrong code', async () => {
    const { fixture, api } = await render({ url: '/setup#token=WRONG' });
    api.setup.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 403,
            error: { message: 'This setup code is not valid', code: 'invalid_setup_token' },
          }),
      ),
    );
    typeInto(fixture, 'username', 'owner');
    typeInto(fixture, 'password', 'correct horse battery');
    typeInto(fixture, 'confirmPassword', 'correct horse battery');
    await submit(fixture);
    expect(textOf(fixture)).toContain('This setup code is not valid');
  });

  it('tells someone moving from another machine how to bring Ilexarium back', async () => {
    const { fixture } = await render();
    expect(textOf(fixture)).toContain('Moving from another machine?');
    expect(textOf(fixture)).toContain('sudo ilex-recover');
  });
});
