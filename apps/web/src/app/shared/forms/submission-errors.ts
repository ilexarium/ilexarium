import { HttpErrorResponse } from '@angular/common/http';
import {
  type FieldTree,
  type SchemaPath,
  type TreeValidationResult,
  validateTree,
} from '@angular/forms/signals';
import {
  ALERT_ERROR_CODES,
  apiErrorResponseSchema,
  AUTH_ERROR_CODES,
  BACKUP_ERROR_CODES,
  CONTAINER_ACTION_ERROR_CODES,
  DISK_ERROR_CODES,
  DOCKER_CLEANUP_ERROR_CODES,
  FILES_ERROR_CODES,
  PROCESS_ERROR_CODES,
  PROFILE_ERROR_CODES,
  APP_ERROR_CODES,
  SYSTEM_SERVICE_ERROR_CODES,
  UPDATE_ERROR_CODES,
} from '@ilex/shared';
import type { FormError, FormSubmission, ServerError } from './forms.model';

/** Server codes with their own text (`errors.<code>` in en.json); others show the server's text. */
export const TRANSLATED_ERROR_CODES: readonly string[] = [
  ...Object.values(AUTH_ERROR_CODES),
  ...Object.values(CONTAINER_ACTION_ERROR_CODES),
  ...Object.values(APP_ERROR_CODES),
  ...Object.values(BACKUP_ERROR_CODES),
  ...Object.values(DISK_ERROR_CODES),
  ...Object.values(DOCKER_CLEANUP_ERROR_CODES),
  ...Object.values(ALERT_ERROR_CODES),
  ...Object.values(PROCESS_ERROR_CODES),
  ...Object.values(FILES_ERROR_CODES),
  ...Object.values(PROFILE_ERROR_CODES),
  ...Object.values(SYSTEM_SERVICE_ERROR_CODES),
  ...Object.values(UPDATE_ERROR_CODES),
];

/** The server's error code of a failed API call, if it sent one. */
export function apiErrorCode(error: unknown): string | undefined {
  if (!(error instanceof HttpErrorResponse)) return undefined;
  const code = (error.error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * A failed API call in words, for a toast: `[key, params]` for the `Translator`. Network trouble,
 * a rate limit, a known code — or "something went wrong (status)".
 */
export function apiErrorText(error: unknown): [string, Record<string, unknown>?] {
  if (!(error instanceof HttpErrorResponse) || error.status === 0) return ['errors.network'];
  if (error.status === 429) return ['errors.tooManyAttempts'];
  const response = apiErrorResponseSchema.safeParse(error.error).data;
  // A refused field's code when the answer has none of its own (a refused backup item).
  const code =
    response?.code ??
    response?.errors?.find((error) => TRANSLATED_ERROR_CODES.includes(error.code))?.code;
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
 * A failed API call as the form errors it means, each with the dotted path of its field (none: the
 * form's own). Messages are translation keys (with `params`), worded by the `errorText` pipe; only
 * an unknown code keeps the server's text. Either the server's field errors or one form error.
 */
export function toServerErrors(error: unknown): ServerError[] {
  if (!(error instanceof HttpErrorResponse) || error.status === 0) {
    return [formError('network', 'errors.network')];
  }
  if (error.status === 429) {
    const seconds = Number(error.headers.get('Retry-After'));
    return seconds > 0
      ? [formError('too_many_attempts', 'errors.tooManyAttemptsIn', { count: seconds })]
      : [formError('too_many_attempts', 'errors.tooManyAttempts')];
  }
  const body = apiErrorResponseSchema.safeParse(error.error);
  if (!body.success) return [formError('server', 'errors.server', { status: error.status })];

  const fieldErrors = (body.data.errors ?? []).map(({ field, code, message }): ServerError => ({
    field,
    kind: code,
    message: messageFor(code, message),
  }));
  return fieldErrors.length > 0
    ? fieldErrors
    : [formError(body.data.code ?? 'server', messageFor(body.data.code, body.data.message))];
}

/**
 * Turns a failed API call into Signal Forms submission errors: the server's field errors land on
 * their fields (shown like client-side errors, cleared when the user edits); anything else becomes
 * a form-level error. Return it from a form's `submission.action`.
 */
export function toSubmissionErrors(error: unknown, form: FieldTree<unknown>): TreeValidationResult {
  const errors = toServerErrors(error);
  const [first] = errors;
  if (errors.length === 1 && first.field === undefined) return first;
  return errors.map(({ field, ...rest }) => ({
    ...rest,
    fieldTree: field === undefined ? undefined : fieldAt(form, field),
  }));
}

/**
 * Shows a store's server errors (`withFormSubmission`) on the form while it still holds what was
 * sent: a field's error while that field does, the form's own while the whole form does. Editing
 * hides one; going back to the refused value shows it again, since the server refused exactly that.
 */
export function validateServerErrors<T>(path: SchemaPath<T>, submission: FormSubmission<T>): void {
  validateTree(path, ({ value, fieldTree }) => {
    const sent = submission.submittedValue();
    if (sent === null) return undefined;
    const current = value();
    const form = fieldTree as FieldTree<unknown>;
    return submission.serverErrors().flatMap(({ field, ...error }): FormError[] => {
      const target = field === undefined ? undefined : fieldAt(form, field);
      const unchanged =
        target && field !== undefined
          ? sameValue(valueAt(current, field), valueAt(sent, field))
          : sameValue(current, sent);
      if (!unchanged) return [];
      return [target ? { ...error, fieldTree: target } : error];
    });
  });
}

/** The value at a dotted path of a form's model. */
function valueAt(model: unknown, path: string): unknown {
  let node = model;
  for (const key of path.split('.')) node = (node as Record<string, unknown> | null)?.[key];
  return node;
}

/** Form models are plain data: equal when they serialise the same. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formError(kind: string, message: string, params?: ServerError['params']): ServerError {
  return params ? { kind, message, params } : { kind, message };
}
