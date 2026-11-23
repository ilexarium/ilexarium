import { Observable, Subject } from 'rxjs';

/**
 * A prompt every waiting action shares: opened by the first, answered once for all of them, and
 * closed (answered "no") when the last one stops waiting — a page left while it's asked.
 */
export class SharedPrompt {
  private answer: Subject<boolean> | null = null;
  private waiting = 0;

  constructor(
    private readonly opened: () => void,
    private readonly closed: () => void,
  ) {}

  /** The answer once given; `true` at once, without asking, while `alreadyYes()` holds. */
  ask(alreadyYes?: () => boolean): Observable<boolean> {
    return new Observable<boolean>((subscriber) => {
      if (alreadyYes?.()) {
        subscriber.next(true);
        subscriber.complete();
        return undefined;
      }
      if (!this.answer) {
        this.answer = new Subject<boolean>();
        this.waiting = 0;
        this.opened();
      }
      const answer = this.answer;
      this.waiting++;
      const subscription = answer.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        if (this.answer === answer && --this.waiting === 0) this.respond(false);
      };
    });
  }

  respond(yes: boolean): void {
    const answer = this.answer;
    this.answer = null;
    this.closed();
    answer?.next(yes);
    answer?.complete();
  }
}
