import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthStore } from './auth-store';

/** Their 401s are form errors (wrong password, wrong code), not an ended session. */
const FORM_ENDPOINTS = new Set(['/api/auth/login', '/api/auth/setup']);

/**
 * A 401 from the API means the session is missing or ended: clear the store and go to the login
 * page, remembering where the user was. "Expired" is only said if they were signed in.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const store = inject(AuthStore);
  const router = inject(Router);
  return next(request).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        request.url.startsWith('/api/') &&
        !FORM_ENDPOINTS.has(request.url)
      ) {
        const wasSignedIn = store.isAuthenticated();
        store.sessionEnded();
        if (!router.url.startsWith('/login')) {
          void router.navigate(['/login'], {
            queryParams: {
              ...(router.url !== '/' && { returnUrl: router.url }),
              ...(wasSignedIn && { reason: 'expired' }),
            },
          });
        }
      }
      return throwError(() => error);
    }),
  );
};
