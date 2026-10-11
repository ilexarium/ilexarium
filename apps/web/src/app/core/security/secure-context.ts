import { DOCUMENT, inject, InjectionToken } from '@angular/core';

/**
 * Whether the browser treats this page as secure (HTTPS, or localhost) — exactly when the
 * `Secure` session cookie can work. A token so tests can set it.
 */
export const SECURE_CONTEXT = new InjectionToken<boolean>('SECURE_CONTEXT', {
  factory: () => inject(DOCUMENT).defaultView?.isSecureContext ?? false,
});
