import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import en from '@ilex/i18n/en.json';
import { flattenMessages } from '@ilex/i18n';
import { apiErrorText, toSubmissionErrors, TRANSLATED_ERROR_CODES } from './submission-errors';

function makeForm() {
  return TestBed.runInInjectionContext(() =>
    form(signal({ currentPassword: '', newPassword: '' })),
  );
}

const httpError = (status: number, body: unknown, headers?: Record<string, string>) =>
  new HttpErrorResponse({ status, error: body, headers: new HttpHeaders(headers) });

describe('toSubmissionErrors', () => {
  it('puts server field errors on their fields, a known code as its own key', () => {
    const f = makeForm();
    const result = toSubmissionErrors(
      httpError(400, {
        message: 'Validation failed',
        errors: [
          { field: 'currentPassword', code: 'wrong_password', message: 'Wrong' },
          { field: 'newPassword', code: 'too_small', message: 'validation.passwordTooShort' },
        ],
      }),
      f,
    );
    expect(result).toEqual([
      { kind: 'wrong_password', message: 'errors.wrong_password', fieldTree: f.currentPassword },
      { kind: 'too_small', message: 'validation.passwordTooShort', fieldTree: f.newPassword },
    ]);
  });

  it('turns a coded error without fields into a form-level error', () => {
    const result = toSubmissionErrors(
      httpError(401, { message: 'Invalid username or password', code: 'invalid_credentials' }),
      makeForm(),
    );
    expect(result).toEqual({ kind: 'invalid_credentials', message: 'errors.invalid_credentials' });
  });

  it('keeps the server’s text for a code without a translation', () => {
    const result = toSubmissionErrors(
      httpError(409, { message: 'Something new happened', code: 'brand_new' }),
      makeForm(),
    );
    expect(result).toEqual({ kind: 'brand_new', message: 'Something new happened' });
  });

  it('says how long to wait on a 429, from Retry-After', () => {
    expect(toSubmissionErrors(httpError(429, {}, { 'Retry-After': '8' }), makeForm())).toEqual({
      kind: 'too_many_attempts',
      message: 'errors.tooManyAttemptsIn',
      params: { count: 8 },
    });
    expect(toSubmissionErrors(httpError(429, {}), makeForm())).toEqual({
      kind: 'too_many_attempts',
      message: 'errors.tooManyAttempts',
    });
  });

  it('reports network failures plainly', () => {
    expect(toSubmissionErrors(httpError(0, null), makeForm())).toEqual({
      kind: 'network',
      message: 'errors.network',
    });
    expect(toSubmissionErrors(new Error('boom'), makeForm())).toMatchObject({ kind: 'network' });
  });

  it('copes with an unexpected body', () => {
    expect(toSubmissionErrors(httpError(502, '<html>'), makeForm())).toEqual({
      kind: 'server',
      message: 'errors.server',
      params: { status: 502 },
    });
  });

  it('keeps an error for an unknown field, as form-level', () => {
    const [error] = toSubmissionErrors(
      httpError(400, { message: 'x', errors: [{ field: 'nope', code: 'c', message: 'm' }] }),
      makeForm(),
    ) as readonly { fieldTree?: unknown }[];
    expect(error.fieldTree).toBeUndefined();
  });

  it('has a text in en.json for every code it translates', () => {
    const keys = Object.keys(flattenMessages(en));
    for (const code of TRANSLATED_ERROR_CODES) expect(keys).toContain(`errors.${code}`);
  });
});

describe('apiErrorText', () => {
  it('words the answer’s code, else its first refused field’s, else the status', () => {
    expect(apiErrorText(httpError(409, { message: 'x', code: 'busy' }))).toEqual(['errors.busy']);
    expect(
      apiErrorText(
        httpError(400, {
          message: 'Validation failed',
          errors: [
            { field: 'items.0', code: 'path_on_backup_disk', message: 'On the backup disk' },
          ],
        }),
      ),
    ).toEqual(['errors.path_on_backup_disk']);
    expect(
      apiErrorText(
        httpError(400, { message: 'x', errors: [{ field: 'f', code: 'c', message: 'm' }] }),
      ),
    ).toEqual(['errors.server', { status: 400 }]);
  });
});
