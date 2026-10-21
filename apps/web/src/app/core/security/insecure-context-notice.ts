import { Component, computed, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { Translator } from '../i18n/translator';

/**
 * Shown instead of the login/setup forms when the page isn't secure: the session cookie can't be
 * stored over plain HTTP, so signing in couldn't work anyway.
 */
@Component({
  selector: 'laris-insecure-context-notice',
  imports: [TranslatePipe],
  templateUrl: './insecure-context-notice.html',
})
export class InsecureContextNotice {
  private readonly translator = inject(Translator);
  /** Around the example address, which the template shows as code. */
  protected readonly text = computed(() => this.translator.around('auth.insecure.text', 'example'));
}
