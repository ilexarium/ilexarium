import { Component, input } from '@angular/core';
import { HlmFieldError } from '@ui/field';
import { ErrorTextPipe } from './error-text-pipe';
import type { WithErrors } from './forms.model';

/** `contents`: the errors are the field's own flex items, spaced by its gap, as if written there. */
@Component({
  selector: 'app-field-errors',
  imports: [HlmFieldError, ErrorTextPipe],
  host: { class: 'contents' },
  templateUrl: './field-errors.html',
})
export class FieldErrors {
  readonly field = input.required<WithErrors>();
}
