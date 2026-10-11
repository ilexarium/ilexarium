import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import { toSubmissionErrors } from './submission-errors';

function makeForm() {
  return TestBed.runInInjectionContext(() =>
    form(signal({ currentPassword: '', newPassword: '' })),
  );
}

const httpError = (status: number, body: unknown, headers?: Record<string, string>) =>
  new HttpErrorResponse({ status, error: body, headers: new HttpHeaders(headers) });

describe('toSubmissionErrors', () => {
  it('puts server field errors on their fields', () => {
    const f = makeForm();
    const result = toSubmissionErrors(
      httpError(400, {
        message: 'Validation failed',
        errors: [{ field: 'currentPassword', code: 'wrong_password', message: 'Wrong' }],
      }),
      f,
    );
    expect(result).toEqual([
      { kind: 'wrong_password', message: 'Wrong', fieldTree: f.currentPassword },
    ]);
  });

  it('turns a coded error without fields into a form-level error', () => {
    const result = toSubmissionErrors(
      httpError(401, { message: 'Invalid username or password', code: 'invalid_credentials' }),
      makeForm(),
    );
    expect(result).toEqual({
      kind: 'invalid_credentials',
      message: 'Invalid username or password',
    });
  });

  it('says how long to wait on a 429, from Retry-After', () => {
    expect(toSubmissionErrors(httpError(429, {}, { 'Retry-After': '8' }), makeForm())).toEqual({
      kind: 'too_many_attempts',
      message: 'Too many attempts. Try again in 8 seconds.',
    });
    expect(
      toSubmissionErrors(httpError(429, {}, { 'Retry-After': '1' }), makeForm()),
    ).toMatchObject({
      message: 'Too many attempts. Try again in 1 second.',
    });
  });

  it('reports network failures plainly', () => {
    expect(toSubmissionErrors(httpError(0, null), makeForm())).toMatchObject({ kind: 'network' });
    expect(toSubmissionErrors(new Error('boom'), makeForm())).toMatchObject({ kind: 'network' });
  });

  it('copes with an unexpected body', () => {
    expect(toSubmissionErrors(httpError(502, '<html>'), makeForm())).toMatchObject({
      kind: 'server',
      message: 'Something went wrong (502).',
    });
  });

  it('keeps an error for an unknown field, as form-level', () => {
    const [error] = toSubmissionErrors(
      httpError(400, { message: 'x', errors: [{ field: 'nope', code: 'c', message: 'm' }] }),
      makeForm(),
    ) as readonly { fieldTree?: unknown }[];
    expect(error.fieldTree).toBeUndefined();
  });
});
