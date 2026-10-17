import { HttpErrorResponse } from '@angular/common/http';
import type { FieldTree, TreeValidationResult, ValidationError } from '@angular/forms/signals';
import {
  ALERT_ERROR_CODES,
  apiErrorResponseSchema,
  AUTH_ERROR_CODES,
  BACKUP_ERROR_CODES,
  CONTAINER_ACTION_ERROR_CODES,
  DISK_ERROR_CODES,
  PROCESS_ERROR_CODES,
  SERVICE_ERROR_CODES,
} from '@homelab/shared';
import type { FormError } from './forms.model';

/** Server codes with their own text (`errors.<code>` in en.json); others show the server's text. */
export const TRANSLATED_ERROR_CODES: readonly string[] = [
  ...Object.values(AUTH_ERROR_CODES),
  ...Object.values(CONTAINER_ACTION_ERROR_CODES),
  ...Object.values(SERVICE_ERROR_CODES),
  ...Object.values(BACKUP_ERROR_CODES),
  ...Object.values(DISK_ERROR_CODES),
  ...Object.values(ALERT_ERROR_CODES),
  ...Object.values(PROCESS_ERROR_CODES),
];

/**
 * A failed API call in words, for a toast: `[key, params]` for the `Translator`. Network trouble,
 * a rate limit, a known code — or "something went wrong (status)".
 */
export function apiErrorText(error: unknown): [string, Record<string, unknown>?] {
  if (!(error instanceof HttpErrorResponse) || error.status === 0) return ['errors.network'];
  if (error.status === 429) return ['errors.tooManyAttempts'];
  const code = apiErrorResponseSchema.safeParse(error.error).data?.code;
  return code && TRANSLATED_ERROR_CODES.includes(code)
    ? [`errors.${code}`]
    : ['errors.server', { status: error.status }];
}

/** The field tree at a dotted path (`currentPassword`, `a.b`), if the form has it. */
function fieldAt(form: FieldTree<unknown>, path: string): FieldTree<unknown> | undefined {
  let node: unknown = form;
  for (const key of path.split('.')) {
    if (!key) return undefined;
    node = (node as Record<string, unknown> | undefined)?.[key];
  }
  return typeof node === 'function' ? (node as FieldTree<unknown>) : undefined;
}

/** A server code's own text if there is one, else what the server said. */
function messageFor(code: string | undefined, serverMessage: string): string {
  return code && TRANSLATED_ERROR_CODES.includes(code) ? `errors.${code}` : serverMessage;
}

/**
 * Turns a failed API call into Signal Forms submission errors: the server's field errors land on
 * their fields (shown like client-side errors, cleared when the user edits); anything else becomes
 * a form-level error. Return it from a form's `submission.action`. Messages are translation keys
 * (with `params`), worded by the `errorText` pipe; only an unknown code keeps the server's text.
 */
export function toSubmissionErrors(error: unknown, form: FieldTree<unknown>): TreeValidationResult {
  if (!(error instanceof HttpErrorResponse) || error.status === 0) {
    return formError('network', 'errors.network');
  }
  if (error.status === 429) {
    const seconds = Number(error.headers.get('Retry-After'));
    return seconds > 0
      ? formError('too_many_attempts', 'errors.tooManyAttemptsIn', { count: seconds })
      : formError('too_many_attempts', 'errors.tooManyAttempts');
  }
  const body = apiErrorResponseSchema.safeParse(error.error);
  if (!body.success) return formError('server', 'errors.server', { status: error.status });

  const fieldErrors = (body.data.errors ?? []).map(({ field, code, message }) => {
    const fieldError: ValidationError.WithOptionalFieldTree = {
      kind: code,
      message: messageFor(code, message),
      fieldTree: fieldAt(form, field),
    };
    return fieldError;
  });
  return fieldErrors.length > 0
    ? fieldErrors
    : formError(body.data.code ?? 'server', messageFor(body.data.code, body.data.message));
}

function formError(kind: string, message: string, params?: FormError['params']): FormError {
  return params ? { kind, message, params } : { kind, message };
}
