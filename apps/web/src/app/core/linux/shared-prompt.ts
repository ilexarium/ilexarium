import { defer, Observable, of, Subject, take } from 'rxjs';

/**
 * A prompt every waiting action shares: opened by the first, answered once for all of them (with
 * a value, or null for "no"). Only an answer closes it — a page left while it's asked leaves it
 * open, its answer then changes nothing for that page.
 */
export class SharedPrompt<T> {
  private answer: Subject<T | null> | null = null;

  constructor(private readonly dialog: { showDialog: () => void; hideDialog: () => void }) {}

  /** The answer once given; at once, without asking, what `skipWith()` gives when not undefined. */
  ask({ skipWith }: { skipWith?: () => T | undefined } = {}): Observable<T | null> {
    return defer(() => {
      const skipped = skipWith?.();
      if (skipped !== undefined) return of(skipped);
      if (!this.answer) {
        this.answer = new Subject<T | null>();
        this.dialog.showDialog();
      }
      return this.answer.pipe(take(1));
    });
  }

  answerWith(value: T | null): void {
    const answer = this.answer;
    this.answer = null;
    this.dialog.hideDialog();
    answer?.next(value);
  }
}
