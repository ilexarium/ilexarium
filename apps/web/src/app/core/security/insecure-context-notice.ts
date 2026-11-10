import { Component } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * Shown instead of the login/setup forms when the page isn't secure: the session cookie can't be
 * stored over plain HTTP, so signing in couldn't work anyway.
 */
@Component({
  selector: 'ilex-insecure-context-notice',
  imports: [TranslatePipe],
  templateUrl: './insecure-context-notice.html',
})
export class InsecureContextNotice {}
