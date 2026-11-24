import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { signalStore, withMethods } from '@ngrx/signals';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { withFormSubmission } from './with-form-submission';

const TestStore = signalStore(
  withFormSubmission<{ name: string }>(),
  withMethods((store) => ({
    send: <R>(value: { name: string }, request: Observable<R>) => store._submit(value, request),
  })),
);

function setup() {
  TestBed.configureTestingModule({ providers: [TestStore] });
  return TestBed.inject(TestStore);
}

describe('withFormSubmission', () => {
  it('is submitting while the request runs and counts a save when it ends', () => {
    const store = setup();
    const answer = new Subject<string>();
    const results: string[] = [];
    store.send({ name: 'a' }, answer).subscribe((result) => results.push(result));
    expect(store.submitting()).toBe(true);
    expect(store.submittedValue()).toEqual({ name: 'a' });

    answer.next('done');
    answer.complete();
    expect(results).toEqual(['done']);
    expect(store.submitting()).toBe(false);
    expect(store.saves()).toBe(1);
    expect(store.serverErrors()).toEqual([]);
    expect(store.submittedValue()).toBeNull();
  });

  it('ends a submission still running on reset: its answer changes nothing', () => {
    const store = setup();
    const answer = new Subject<string>();
    let completed = false;
    store.send({ name: 'a' }, answer).subscribe({ complete: () => (completed = true) });
    store.resetSubmission();
    expect(completed).toBe(true);
    expect(answer.observed).toBe(false);
    expect(store.submitting()).toBe(false);
    answer.next('late');
    expect(store.saves()).toBe(0);
  });

  it('turns a refusal into server errors by field and ends without a value or save', () => {
    const store = setup();
    const error = new HttpErrorResponse({
      status: 400,
      error: {
        message: 'Validation failed',
        errors: [{ field: 'name', code: 'name_taken', message: 'Taken' }],
      },
    });
    let completed = false;
    store
      .send(
        { name: 'a' },
        throwError(() => error),
      )
      .subscribe({
        next: () => expect.unreachable(),
        complete: () => (completed = true),
      });
    expect(completed).toBe(true);
    expect(store.serverErrors()).toEqual([{ field: 'name', kind: 'name_taken', message: 'Taken' }]);
    expect(store.submitting()).toBe(false);
    expect(store.saves()).toBe(0);
  });

  it('clears the last errors when sending again', () => {
    const store = setup();
    store
      .send(
        { name: 'a' },
        throwError(() => new Error('offline')),
      )
      .subscribe();
    expect(store.serverErrors()).toEqual([{ kind: 'network', message: 'errors.network' }]);
    store.send({ name: 'b' }, of(null)).subscribe();
    expect(store.serverErrors()).toEqual([]);
  });

  it('sends nothing before it is subscribed', () => {
    const store = setup();
    store.send({ name: 'a' }, of(null));
    expect(store.submitting()).toBe(false);
    expect(store.submittedValue()).toBeNull();
  });

  it('forgets everything on reset', () => {
    const store = setup();
    store.send({ name: 'a' }, of(null)).subscribe();
    store.resetSubmission();
    expect(store.saves()).toBe(0);
    expect(store.submittedValue()).toBeNull();
  });
});
