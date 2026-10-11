import { Component, inject } from '@angular/core';
import { SECURE_CONTEXT } from './secure-context';

/**
 * Shown instead of the login/setup forms when the page isn't secure: the session cookie can't be
 * stored over plain HTTP, so signing in couldn't work anyway.
 */
@Component({
  selector: 'app-insecure-context-notice',
  templateUrl: './insecure-context-notice.html',
})
export class InsecureContextNotice {}

/** For templates: `@if (secure) { form } @else { <app-insecure-context-notice /> }`. */
export function injectSecureContext(): boolean {
  return inject(SECURE_CONTEXT);
}
