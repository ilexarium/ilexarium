import { Injectable } from '@nestjs/common';
import { ANONYMOUS_HASHES_AT_ONCE, HASHES_BUSY_RETRY_AFTER_SECONDS } from './auth.constants.js';
import { TooManyAttemptsException } from './login-throttle.service.js';

/** Runs an anonymous password check, or answers 429 at once while all slots are taken. */
@Injectable()
export class PasswordHashSlots {
  private running = 0;

  async run<T>(check: () => Promise<T>): Promise<T> {
    if (this.running >= ANONYMOUS_HASHES_AT_ONCE)
      throw new TooManyAttemptsException(HASHES_BUSY_RETRY_AFTER_SECONDS);
    this.running += 1;
    try {
      return await check();
    } finally {
      this.running -= 1;
    }
  }
}
