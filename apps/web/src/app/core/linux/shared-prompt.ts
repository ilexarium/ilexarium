import { Observable, Subject } from 'rxjs';

/**
 * A prompt every waiting action shares: opened by the first, answered once for all of them, and
 * closed (answered "no") when the last one stops waiting — a page left while it's asked.
 */
export class SharedPrompt {
  private answer: Subject<boolean> | null = null;
  private waiting = 0;

  constructor(private readonly dialog: { showDialog: () => void; hideDialog: () => void }) {}

  /** The answer once given; `true` at once, without asking, while `skipWhen()` holds. */
  ask({ skipWhen }: { skipWhen?: () => boolean } = {}): Observable<boolean> {
    return new Observable<boolean>((subscriber) => {
      if (skipWhen?.()) {
        subscriber.next(true);
        subscriber.complete();
        return undefined;
      }
      if (!this.answer) {
        this.answer = new Subject<boolean>();
        this.waiting = 0;
        this.dialog.showDialog();
      }
      const answer = this.answer;
      this.waiting++;
      const subscription = answer.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        if (this.answer === answer && --this.waiting === 0) this.answerWith(false);
      };
    });
  }

  answerWith(yes: boolean): void {
    const answer = this.answer;
    this.answer = null;
    this.dialog.hideDialog();
    answer?.next(yes);
    answer?.complete();
  }
}
