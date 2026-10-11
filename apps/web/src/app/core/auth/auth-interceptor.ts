import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthStore } from './auth-store';

/** Their 401s are form errors (wrong password, wrong code), not an ended session. */
const FORM_ENDPOINTS = new Set(['/api/auth/login', '/api/auth/setup']);

/** A 401 from the API means the session is missing or ended (see `AuthStore.sessionExpired`). */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const store = inject(AuthStore);
  return next(request).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        request.url.startsWith('/api/') &&
        !FORM_ENDPOINTS.has(request.url)
      ) {
        store.sessionExpired();
      }
      return throwError(() => error);
    }),
  );
};
