import { catchError, EMPTY, from, type Observable } from 'rxjs';

/**
 * One async step of a stream: its value, or — when it fails — nothing, with the error handed to
 * `onError`. An error must never reach a subscription (RxJS would re-throw it and stop the server).
 */
export function safely<T>(work: Promise<T>, onError: (error: unknown) => void): Observable<T> {
  return from(work).pipe(
    catchError((error: unknown) => {
      onError(error);
      return EMPTY;
    }),
  );
}
