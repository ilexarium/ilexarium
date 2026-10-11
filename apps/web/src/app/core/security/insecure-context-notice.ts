import { Component, inject } from '@angular/core';
import { SECURE_CONTEXT } from './secure-context';

/**
 * Shown instead of the login/setup forms when the page isn't secure: the session cookie can't be
 * stored over plain HTTP, so signing in couldn't work anyway.
 */
@Component({
  selector: 'app-insecure-context-notice',
  template: `
    <div role="alert" class="rounded-lg border border-destructive/50 p-4 text-sm">
      <p class="font-medium text-destructive">This connection isn't encrypted</p>
      <p class="mt-1 text-muted-foreground">
        Open this app over HTTPS — for example <code>https://&lt;your-server&gt;.ts.net</code> with
        Tailscale. Signing in isn't possible over an unencrypted connection.
      </p>
    </div>
  `,
})
export class InsecureContextNotice {}

/** For templates: `@if (secure) { form } @else { <app-insecure-context-notice /> }`. */
export function injectSecureContext(): boolean {
  return inject(SECURE_CONTEXT);
}
