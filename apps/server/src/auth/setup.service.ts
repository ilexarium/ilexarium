import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Env } from '../config/env.schema.js';
import { UsersService } from '../users/users.service.js';
import { BASE32_ALPHABET, TOKEN_LENGTH } from './setup.constants.js';

/** `byte & 31` is uniform, as 32 divides 256. Groups of four: easy to read, and to type. */
function generateToken(): string {
  const letters = Array.from(randomBytes(TOKEN_LENGTH), (byte) => BASE32_ALPHABET[byte & 31]);
  return letters
    .join('')
    .match(/.{1,4}/g)!
    .join('-');
}

/** Case, dashes and spaces don't matter: `k7qd 9f2m…` equals `K7QD-9F2M-…`. */
export function normaliseSetupToken(token: string): string {
  return token.toUpperCase().replace(/[\s-]/g, '');
}

function digest(token: string): Buffer {
  return createHash('sha256').update(normaliseSetupToken(token)).digest();
}

/** docs/plans/auth.md, decision 1. Only the token's hash stays in memory, never the token. */
@Injectable()
export class SetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SetupService.name);
  private readonly tokenFile: string;
  private pendingHash: Buffer | null = null;

  constructor(
    private readonly users: UsersService,
    config: ConfigService<Env, true>,
  ) {
    this.tokenFile = resolve(config.get('SETUP_TOKEN_FILE', { infer: true }));
  }

  async onApplicationBootstrap(): Promise<void> {
    if (await this.users.hasAnyUser()) {
      await this.removeTokenFile(); // e.g. left over from a crash after setup
      return;
    }
    const token = generateToken();
    await this.writeTokenFile(token);
    this.pendingHash = digest(token);
    this.logger.warn(`Setup pending: the one-time setup code is in ${this.tokenFile}`);
  }

  isPending(): boolean {
    return this.pendingHash !== null;
  }

  verify(token: string): boolean {
    return this.pendingHash !== null && timingSafeEqual(digest(token), this.pendingHash);
  }

  async complete(): Promise<void> {
    this.pendingHash = null;
    await this.removeTokenFile();
    this.logger.log('Setup complete; setup code removed');
  }

  /**
   * Never readable by others, even briefly: created exclusively (`wx`, so a planted symlink can't
   * redirect it) with mode 0600, chmod'ed in case of an unusual umask, then renamed into place.
   */
  private async writeTokenFile(token: string): Promise<void> {
    const dir = dirname(this.tokenFile);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `.setup-token-${randomBytes(8).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${token}\n`);
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, this.tokenFile);
  }

  private async removeTokenFile(): Promise<void> {
    await rm(this.tokenFile, { force: true });
  }
}
