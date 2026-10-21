import { Component, input } from '@angular/core';
import { HlmAlertImports } from '@ui/alert';
import { ErrorTextPipe } from './error-text-pipe';
import type { WithErrors } from './forms.model';

/** The errors that belong to no single field (a wrong password, the server unreachable). */
@Component({
  selector: 'app-form-errors',
  imports: [HlmAlertImports, ErrorTextPipe],
  templateUrl: './form-errors.html',
})
export class FormErrors {
  readonly form = input.required<WithErrors>();
}
