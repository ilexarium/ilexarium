import { HttpErrorResponse } from '@angular/common/http';
import type { FieldTree, TreeValidationResult, ValidationError } from '@angular/forms/signals';
import { apiErrorResponseSchema } from '@homelab/shared';

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

/** The field tree at a dotted path (`currentPassword`, `a.b`), if the form has it. */
function fieldAt(form: FieldTree<unknown>, path: string): FieldTree<unknown> | undefined {
  let node: unknown = form;
  for (const key of path.split('.')) {
    if (!key) return undefined;
    node = (node as Record<string, unknown> | undefined)?.[key];
  }
  return typeof node === 'function' ? (node as FieldTree<unknown>) : undefined;
}

/**
 * Turns a failed API call into Signal Forms submission errors: the server's field errors land on
 * their fields (shown like client-side errors, cleared when the user edits); anything else becomes
 * a form-level error. Return it from a form's `submission.action`.
 */
export function toSubmissionErrors(error: unknown, form: FieldTree<unknown>): TreeValidationResult {
  if (!(error instanceof HttpErrorResponse) || error.status === 0) {
    return { kind: 'network', message: NETWORK_ERROR };
  }
  if (error.status === 429) {
    const seconds = Number(error.headers.get('Retry-After'));
    return {
      kind: 'too_many_attempts',
      message:
        seconds > 0
          ? `Too many attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
          : 'Too many attempts. Try again later.',
    };
  }
  const body = apiErrorResponseSchema.safeParse(error.error);
  if (!body.success) return { kind: 'server', message: `Something went wrong (${error.status}).` };

  const fieldErrors: ValidationError.WithOptionalFieldTree[] = (body.data.errors ?? []).map(
    ({ field, code, message }) => ({ kind: code, message, fieldTree: fieldAt(form, field) }),
  );
  return fieldErrors.length > 0
    ? fieldErrors
    : { kind: body.data.code ?? 'server', message: body.data.message };
}
