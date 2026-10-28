import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';
import { APP_QUIET_MS } from './jobs.constants.js';

/**
 * What Laris knows is changing apps on purpose right now — a backup run or a restore (followed
 * from the root program's files) and the app tasks it started — so a container stopping then
 * isn't an alert. Nothing waits on it: one operation at a time is the root programs' lock.
 */
@Injectable()
export class ChangesUnderway {
  private readonly sources: (() => boolean)[] = [];
  private readonly apps = new Map<string, number>();
  private readonly changed = new Subject<void>();

  /** Something started or ended. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  /** A backup run or a restore is running (every app may be stopped for it). */
  anything(): boolean {
    return this.sources.some((running) => running());
  }

  /** This app is being changed: one of its tasks started a little while ago, or anything above. */
  app(project: string | null): boolean {
    const until = project ? this.apps.get(project) : undefined;
    return this.anything() || (until !== undefined && until > Date.now());
  }

  /** A follower that knows when its work runs (backup runs, restores). */
  follow(running: () => boolean): void {
    this.sources.push(running);
  }

  /** An app task started (install, change, update, removal): its stops count as on purpose for a while. */
  appTask(project: string): void {
    const now = Date.now();
    for (const [name, until] of this.apps) if (until <= now) this.apps.delete(name);
    this.apps.set(project, now + APP_QUIET_MS);
    this.notify();
  }

  notify(): void {
    this.changed.next();
  }
}
