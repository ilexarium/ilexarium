import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthStore } from './auth-store';
import { safeReturnUrl } from './return-url';

/** Signed-in users only; otherwise setup (fresh install) or login, remembering the target. */
export const authGuard: CanActivateFn = (_route, state) => {
  const store = inject(AuthStore);
  const router = inject(Router);
  if (store.isAuthenticated()) return true;
  if (store.needsSetup()) return router.createUrlTree(['/setup']);
  return router.createUrlTree(['/login'], {
    queryParams: state.url === '/' ? {} : { returnUrl: state.url },
  });
};

/** The login page, for signed-out users; signed-in users go where they were headed. */
export const guestGuard: CanActivateFn = (route) => {
  const store = inject(AuthStore);
  const router = inject(Router);
  if (store.isAuthenticated()) {
    return router.parseUrl(safeReturnUrl(route.queryParamMap.get('returnUrl')));
  }
  if (store.needsSetup()) return router.createUrlTree(['/setup']);
  return true;
};

/** The setup page, only while no account exists. */
export const setupGuard: CanActivateFn = () => {
  const store = inject(AuthStore);
  const router = inject(Router);
  if (store.needsSetup()) return true;
  return router.createUrlTree([store.isAuthenticated() ? '/' : '/login']);
};
