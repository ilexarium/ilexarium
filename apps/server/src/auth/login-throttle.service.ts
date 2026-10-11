import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { AUTH_ERROR_CODES, type ApiErrorResponse } from '@homelab/shared';

const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
/** Forget a username this long after its last failure. */
const ENTRY_TTL_MS = 15 * 60_000;
/** Bound on tracked usernames — nonexistent ones are tracked too, so this must be capped. */
const MAX_ENTRIES = 10_000;

interface Entry {
  failures: number;
  blockedUntil: number;
  lastFailureAt: number;
}

/** 429 with how long to wait; `TooManyAttemptsFilter` turns `retryAfterSeconds` into a header. */
export class TooManyAttemptsException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    const body: ApiErrorResponse = {
      message: `Too many attempts. Try again in ${retryAfterSeconds} seconds.`,
      code: AUTH_ERROR_CODES.tooManyAttempts,
    };
    super(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * Per-username backoff after failed password checks (on top of per-IP throttling): the delay
 * doubles from 1 s and is capped at 60 s — a delay, not a lockout, so nobody on the network can
 * lock the owner out. In memory: one process, forgotten on restart.
 */
@Injectable()
export class LoginThrottleService {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Throws `TooManyAttemptsException` while the username is in its delay. */
  assertAllowed(username: string): void {
    const entry = this.live(username);
    if (!entry) return;
    const waitMs = entry.blockedUntil - this.now();
    if (waitMs > 0) throw new TooManyAttemptsException(Math.ceil(waitMs / 1000));
  }

  recordFailure(username: string): void {
    const now = this.now();
    const failures = (this.live(username)?.failures ?? 0) + 1;
    const delay = Math.min(FIRST_DELAY_MS * 2 ** (failures - 1), MAX_DELAY_MS);
    // Re-insert so the Map's insertion order stays least-recently-failed first.
    this.entries.delete(username);
    this.entries.set(username, { failures, blockedUntil: now + delay, lastFailureAt: now });
    while (this.entries.size > MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  reset(username: string): void {
    this.entries.delete(username);
  }

  /** Number of usernames currently tracked. For tests. */
  get size(): number {
    return this.entries.size;
  }

  private live(username: string): Entry | undefined {
    const entry = this.entries.get(username);
    if (entry && this.now() - entry.lastFailureAt > ENTRY_TTL_MS) {
      this.entries.delete(username);
      return undefined;
    }
    return entry;
  }
}
