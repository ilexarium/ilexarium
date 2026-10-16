import { Observable } from 'rxjs';

/**
 * An abortable async iterable (Docker's streams: stats, events) as an Observable: opened on
 * subscribe, aborted on unsubscribe. It completes when the iterable ends by itself; an error
 * after the abort is the abort's own and isn't reported.
 */
export function fromAbortable<T>(open: (signal: AbortSignal) => AsyncIterable<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const value of open(controller.signal)) {
          if (controller.signal.aborted) break;
          subscriber.next(value);
        }
        subscriber.complete();
      } catch (error) {
        if (!controller.signal.aborted) subscriber.error(error);
      }
    })();
    return () => controller.abort();
  });
}
