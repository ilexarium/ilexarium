import { Component, computed, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { Translator } from '../i18n/translator';
import { SECURE_CONTEXT } from './secure-context';

/**
 * Shown instead of the login/setup forms when the page isn't secure: the session cookie can't be
 * stored over plain HTTP, so signing in couldn't work anyway.
 */
@Component({
  selector: 'app-insecure-context-notice',
  imports: [TranslatePipe],
  templateUrl: './insecure-context-notice.html',
})
export class InsecureContextNotice {
  /** Around the example address, which the template shows as code. */
  private readonly translator = inject(Translator);
  protected readonly text = computed(() => this.translator.around('auth.insecure.text', 'example'));
}

/** For templates: `@if (secure) { form } @else { <app-insecure-context-notice /> }`. */
export function injectSecureContext(): boolean {
  return inject(SECURE_CONTEXT);
}
