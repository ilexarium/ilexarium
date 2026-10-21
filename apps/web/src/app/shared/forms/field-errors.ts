import { Component, inject, input } from '@angular/core';
import { BrnFieldA11yService } from '@spartan-ng/brain/field';
import { HlmFieldError } from '@ui/field';
import { ErrorTextPipe } from './error-text-pipe';
import type { WithErrors } from './forms.model';

/**
 * Inside an `hlmField`. `hlm-field-error` finds the field's a11y service with `host: true`, which
 * stops at this component: passed through, so the input's `aria-describedby` still names the error.
 */
@Component({
  selector: 'app-field-errors',
  imports: [HlmFieldError, ErrorTextPipe],
  viewProviders: [
    {
      provide: BrnFieldA11yService,
      useFactory: () => inject(BrnFieldA11yService, { skipSelf: true }),
    },
  ],
  templateUrl: './field-errors.html',
})
export class FieldErrors {
  readonly field = input.required<WithErrors>();
}
