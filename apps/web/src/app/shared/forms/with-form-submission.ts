import { patchState, signalStoreFeature, withMethods, withProps, withState } from '@ngrx/signals';
import { catchError, defer, EMPTY, finalize, type Observable, Subject, takeUntil, tap } from 'rxjs';
import type { FormSubmissionState } from './forms.model';
import { toServerErrors } from './submission-errors';
import { NO_SUBMISSION } from './with-form-submission.constants';

/**
 * A form's submission as store state, so the submit is an rxMethod like any other action: what was
 * sent, while it runs, the server's errors (shown by `validateServerErrors`), and whether it was saved.
 */
export function withFormSubmission<T>() {
  return signalStoreFeature(
    withState<FormSubmissionState<T>>(NO_SUBMISSION),
    withProps(() => ({ _reset: new Subject<void>() })),
    withMethods((store) => ({
      /** Forgets the last submission and ends one still running (the form closed or opened again). */
      resetSubmission(): void {
        store._reset.next();
        patchState(store, NO_SUBMISSION);
      },

      /** Sends `value` through `request`; a refusal becomes `serverErrors` and ends quietly. */
      _submit<R>(value: T, request: Observable<R>): Observable<R> {
        return defer(() => {
          patchState(store, {
            submitting: true,
            submittedValue: value,
            serverErrors: [],
            saved: false,
          });
          return request.pipe(
            // Saved: the sent value (passwords, say) isn't needed any more.
            tap({ complete: () => patchState(store, { saved: true, submittedValue: null }) }),
            catchError((error: unknown) => {
              patchState(store, { serverErrors: toServerErrors(error) });
              return EMPTY;
            }),
            takeUntil(store._reset),
            finalize(() => patchState(store, { submitting: false })),
          );
        });
      },
    })),
  );
}
