import type { ValidationError } from '@angular/forms/signals';

/** A form error whose message is a translation key, with its parameters (`count` → plural). */
export type FormError = ValidationError.WithOptionalFieldTree & {
  params?: Record<string, string | number>;
};
