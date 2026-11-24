import { patchState, signalStoreFeature, withMethods, withState } from '@ngrx/signals';
import { catchError, defer, EMPTY, finalize, type Observable, tap } from 'rxjs';
import type { FormSubmissionState } from './forms.model';
import { toServerErrors } from './submission-errors';
import { NO_SUBMISSION } from './with-form-submission.constants';

/**
 * A form's submission as store state, so the submit is an rxMethod like any other action: what was
 * sent, while it runs, the server's errors (shown by `validateServerErrors`), and the saves.
 */
export function withFormSubmission<T>() {
  return signalStoreFeature(
    withState<FormSubmissionState<T>>(NO_SUBMISSION),
    withMethods((store) => ({
      /** Forgets the last submission (the form opened again). */
      resetSubmission(): void {
        patchState(store, NO_SUBMISSION);
      },

      /** Sends `value` through `request`; a refusal becomes `serverErrors` and ends quietly. */
      _submit<R>(value: T, request: Observable<R>): Observable<R> {
        return defer(() => {
          patchState(store, { submitting: true, submittedValue: value, serverErrors: [] });
          return request.pipe(
            tap({ complete: () => patchState(store, ({ saves }) => ({ saves: saves + 1 })) }),
            catchError((error: unknown) => {
              patchState(store, { serverErrors: toServerErrors(error) });
              return EMPTY;
            }),
            finalize(() => patchState(store, { submitting: false })),
          );
        });
      },
    })),
  );
}
