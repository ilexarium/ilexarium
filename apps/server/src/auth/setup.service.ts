import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Env } from '../config/env.schema.js';
import { UsersService } from '../users/users.service.js';

const TOKEN_BYTES = 16; // 128 bits
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648

/** Base32 (no padding) in groups of four: easy to read, and to type if it comes to that. */
function formatToken(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let encoded = '';
  for (let i = 0; i < bits.length; i += 5) {
    encoded += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return encoded.match(/.{1,4}/g)!.join('-');
}

/** Case, dashes and spaces don't matter: `k7qd 9f2m…` equals `K7QD-9F2M-…`. */
export function normaliseSetupToken(token: string): string {
  return token.toUpperCase().replace(/[\s-]/g, '');
}

function digest(token: string): Buffer {
  return createHash('sha256').update(normaliseSetupToken(token)).digest();
}

/**
 * The one-time setup token (docs/plans/auth.md, decision 1). While no user exists, a fresh token
 * is generated at every start and written to SETUP_TOKEN_FILE, readable only by the app user.
 * Only its hash stays in memory, and the log says where the file is — never the token.
 */
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
    const token = formatToken(randomBytes(TOKEN_BYTES));
    await this.writeTokenFile(token);
    this.pendingHash = digest(token);
    this.logger.warn(`Setup pending: the one-time setup code is in ${this.tokenFile}`);
  }

  isPending(): boolean {
    return this.pendingHash !== null;
  }

  /** Constant-time check of a submitted token against the pending one. */
  verify(token: string): boolean {
    return this.pendingHash !== null && timingSafeEqual(digest(token), this.pendingHash);
  }

  /** Setup is done: forget the token and delete its file. */
  async complete(): Promise<void> {
    this.pendingHash = null;
    await this.removeTokenFile();
    this.logger.log('Setup complete; setup code removed');
  }

  /**
   * Written so the file is never readable by others, even briefly: a new temporary file created
   * exclusively (`wx`, so a planted symlink can't redirect it) with mode 0600, chmod'ed in case of
   * an unusual umask, then renamed into place atomically.
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
