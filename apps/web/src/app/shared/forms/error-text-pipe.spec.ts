import { TestBed } from '@angular/core/testing';
import type { ValidationError } from '@angular/forms/signals';
import { ErrorTextPipe } from './error-text-pipe';

describe('ErrorTextPipe', () => {
  const text = (error: object) =>
    TestBed.runInInjectionContext(() => new ErrorTextPipe()).transform(error as ValidationError);

  it('words a schema message with the validation limits', () => {
    expect(text({ kind: 'too_small', message: 'validation.passwordTooShort' })).toBe(
      'At least 12 characters',
    );
  });

  it('words an error key with its params, a count picking the plural form', () => {
    expect(text({ kind: 'server', message: 'errors.server', params: { status: 502 } })).toBe(
      'Something went wrong (502).',
    );
    expect(text({ kind: 'x', message: 'errors.tooManyAttemptsIn', params: { count: 1 } })).toBe(
      'Too many attempts. Try again in 1 second.',
    );
    expect(text({ kind: 'x', message: 'errors.tooManyAttemptsIn', params: { count: 8 } })).toBe(
      'Too many attempts. Try again in 8 seconds.',
    );
  });

  it('shows a server’s own text as it is', () => {
    expect(text({ kind: 'brand_new', message: 'Something new happened' })).toBe(
      'Something new happened',
    );
  });
});
