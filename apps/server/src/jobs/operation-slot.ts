import { ConflictException, Injectable } from '@nestjs/common';
import { SERVICE_ERROR_CODES } from '@homelab/shared';
import { type Observable, Subject } from 'rxjs';
import type { OperationKind } from './jobs.model.js';

/**
 * One privileged operation at a time, platform-wide: installs, removals, restores and backup
 * runs. The root wrappers enforce the same with their shared lock; this gives a friendly 409
 * before anything starts. A scheduled backup run isn't started by the app, so the backups feature
 * reports one it sees running (`followExternal`).
 */
@Injectable()
export class OperationSlot {
  private claimed: OperationKind | null = null;
  private external: () => OperationKind | null = () => null;
  private readonly changed = new Subject<void>();

  /** The slot was taken or freed. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  /** What's running now, or null. */
  current(): OperationKind | null {
    return this.claimed ?? this.external();
  }

  /**
   * Takes the slot, before any await — so two requests can't both pass. Returns its release
   * (safe to call twice). Throws a 409 `busy` while anything runs.
   */
  claim(kind: OperationKind): () => void {
    const running = this.current();
    if (running) {
      throw new ConflictException({
        message: `Another operation is running (${running})`,
        code: SERVICE_ERROR_CODES.busy,
      });
    }
    this.claimed = kind;
    this.notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.claimed = null;
      this.notify();
    };
  }

  /** An operation running outside the app (a scheduled backup), as its follower sees it. */
  followExternal(source: () => OperationKind | null): void {
    this.external = source;
  }

  private notify(): void {
    this.changed.next();
  }
}
