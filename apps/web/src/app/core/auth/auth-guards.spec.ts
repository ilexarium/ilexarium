import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  convertToParamMap,
  provideRouter,
  Router,
  type RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { authGuard, guestGuard, setupGuard } from './auth-guards';
import { AuthStore } from './auth-store';
import { fakeAuthApi, OWNER } from './testing';

async function setup(server: Parameters<typeof fakeAuthApi>[0]) {
  TestBed.configureTestingModule({ providers: [provideRouter([]), fakeAuthApi(server).provider] });
  await TestBed.inject(AuthStore).load();
  const router = TestBed.inject(Router);
  const run = (guard: typeof authGuard, url = '/', returnUrl?: string) => {
    const route = {
      queryParamMap: convertToParamMap(returnUrl ? { returnUrl } : {}),
    } as ActivatedRouteSnapshot;
    const result = TestBed.runInInjectionContext(() =>
      guard(route, { url } as RouterStateSnapshot),
    );
    return result instanceof UrlTree ? router.serializeUrl(result) : result;
  };
  return { run };
}

describe('authGuard', () => {
  it('lets signed-in users through', async () => {
    expect((await setup({ user: OWNER })).run(authGuard, '/settings/account')).toBe(true);
  });

  it('sends signed-out users to login, remembering the target', async () => {
    expect((await setup({})).run(authGuard, '/settings/account')).toBe(
      '/login?returnUrl=%2Fsettings%2Faccount',
    );
    expect((await setupFresh({})).run(authGuard, '/')).toBe('/login');
  });

  it('sends a fresh install to setup', async () => {
    expect((await setup({ needsSetup: true })).run(authGuard)).toBe('/setup');
  });
});

describe('guestGuard', () => {
  it('lets signed-out users see the login page', async () => {
    expect((await setup({})).run(guestGuard)).toBe(true);
  });

  it('sends signed-in users to their (safe) return URL', async () => {
    const { run } = await setup({ user: OWNER });
    expect(run(guestGuard, '/login', '/settings/account')).toBe('/settings/account');
    expect(run(guestGuard, '/login', 'https://evil.example')).toBe('/');
  });

  it('sends a fresh install to setup', async () => {
    expect((await setup({ needsSetup: true })).run(guestGuard)).toBe('/setup');
  });
});

describe('setupGuard', () => {
  it('allows setup only while needed', async () => {
    expect((await setup({ needsSetup: true })).run(setupGuard)).toBe(true);
  });

  it('otherwise sends to login, or home when signed in', async () => {
    expect((await setup({})).run(setupGuard)).toBe('/login');
    expect((await setupFresh({ user: OWNER })).run(setupGuard)).toBe('/');
  });
});

/** A second TestBed configuration in the same test. */
function setupFresh(server: Parameters<typeof fakeAuthApi>[0]) {
  TestBed.resetTestingModule();
  return setup(server);
}
