import { watch } from 'node:fs';
import { Observable, retry } from 'rxjs';

/**
 * A notice for each change in a folder (fs.watch). While the folder is missing — or after the
 * watch failed — it's tried again every `retryMs`. Unsubscribing closes the watcher.
 */
export function watchFolder(dir: () => string, retryMs: number): Observable<void> {
  return new Observable<void>((subscriber) => {
    const watcher = watch(dir(), { persistent: false }, () => subscriber.next());
    watcher.on('error', (error) => subscriber.error(error));
    return () => watcher.close();
  }).pipe(retry({ delay: retryMs }));
}
