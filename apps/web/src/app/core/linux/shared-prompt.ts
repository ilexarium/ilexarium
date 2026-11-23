import { defer, Observable, of, Subject, take } from 'rxjs';

/**
 * A prompt every waiting action shares: opened by the first, answered once for all of them. Only
 * an answer closes it — a page left while it's asked leaves it open, its answer then changes
 * nothing for that page.
 */
export class SharedPrompt {
  private answer: Subject<boolean> | null = null;

  constructor(private readonly dialog: { showDialog: () => void; hideDialog: () => void }) {}

  /** The answer once given; `true` at once, without asking, while `skipWhen()` holds. */
  ask({ skipWhen }: { skipWhen?: () => boolean } = {}): Observable<boolean> {
    return defer(() => {
      if (skipWhen?.()) return of(true);
      if (!this.answer) {
        this.answer = new Subject<boolean>();
        this.dialog.showDialog();
      }
      return this.answer.pipe(take(1));
    });
  }

  answerWith(yes: boolean): void {
    const answer = this.answer;
    this.answer = null;
    this.dialog.hideDialog();
    answer?.next(yes);
  }
}
