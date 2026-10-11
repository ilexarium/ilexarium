import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { authInterceptor } from './auth-interceptor';
import { AuthStore } from './auth-store';
import { fakeAuthApi, OWNER } from './testing';

async function setup({ signedIn = true, at = '/settings/account' } = {}) {
  const fake = fakeAuthApi({ user: signedIn ? OWNER : null });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      fake.provider,
    ],
  });
  const store = TestBed.inject(AuthStore);
  await store.load();
  const router = TestBed.inject(Router);
  await router.navigateByUrl(at);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const http = TestBed.inject(HttpClient);
  const backend = TestBed.inject(HttpTestingController);
  const call = (url: string, status: number) => {
    const response = firstValueFrom(http.get(url)).catch((error: unknown) => error);
    backend.expectOne(url).flush({}, { status, statusText: 'x' });
    return response;
  };
  return { store, navigate, call };
}

describe('authInterceptor', () => {
  it('on a 401, clears the session and goes to login with the return URL and "expired"', async () => {
    const { store, navigate, call } = await setup();
    await call('/api/services', 401);
    expect(store.isAuthenticated()).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/settings/account', reason: 'expired' },
    });
  });

  it('does not say "expired" if the user was never signed in', async () => {
    const { navigate, call } = await setup({ signedIn: false });
    await call('/api/services', 401);
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/settings/account' },
    });
  });

  it.each(['/api/auth/login', '/api/auth/setup'])(
    'ignores 401s from %s (form errors)',
    async (url) => {
      const { store, navigate, call } = await setup();
      await call(url, 401);
      expect(store.isAuthenticated()).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it('ignores other statuses', async () => {
    const { store, navigate, call } = await setup();
    for (const status of [400, 403, 429, 500]) await call('/api/services', status);
    expect(store.isAuthenticated()).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate again when already on the login page', async () => {
    const { navigate, call } = await setup({ at: '/login' });
    await call('/api/services', 401);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('still passes the error on to the caller', async () => {
    const { call } = await setup();
    expect(await call('/api/services', 401)).toMatchObject({ status: 401 });
  });
});
