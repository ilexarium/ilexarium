import type { Signal } from '@angular/core';
import type { ValidationError } from '@angular/forms/signals';

/** A form error whose message is a translation key, with its parameters (`count` → plural). */
export type FormError = ValidationError.WithOptionalFieldTree & {
  params?: Record<string, string | number>;
};

/** Any field or form of Signal Forms: what the error components need of it. */
export type WithErrors = () => { errors: Signal<readonly ValidationError[]> };
