import type { Signal } from '@angular/core';
import type { ValidationError } from '@angular/forms/signals';

/** A form error whose message is a translation key, with its parameters (`count` → plural). */
export type FormError = ValidationError.WithOptionalFieldTree & {
  params?: Record<string, string | number>;
};

/** Any field or form of Signal Forms: what the error components need of it. */
export type WithErrors = () => { errors: Signal<readonly ValidationError[]> };

/** A server's form error: its field's dotted path (none: the form's own), a key and its params. */
export interface ServerError {
  field?: string;
  kind: string;
  message: string;
  params?: Record<string, string | number>;
}

/** A form's submission in a store (`withFormSubmission`). */
export interface FormSubmissionState<T> {
  submitting: boolean;
  /** What was sent last, to show the server's errors while the form still holds it. */
  submittedValue: T | null;
  serverErrors: readonly ServerError[];
  /** The last submission succeeded: a dialog closes on it. */
  saved: boolean;
}

/** What `validateServerErrors` reads of a store with `withFormSubmission`. */
export interface FormSubmission<T> {
  submittedValue: Signal<T | null>;
  serverErrors: Signal<readonly ServerError[]>;
}
