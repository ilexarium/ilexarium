import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Env } from '../config/env.schema.js';

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM's standard nonce size
const TAG_BYTES = 16;
/** First byte of every stored value: the format, so a later algorithm or key can be told apart. */
const FORMAT_V1 = 0x01;
const GENERATED_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Encrypts services' secrets at rest (docs/plans/service_deploys.md, decision 7): AES-256-GCM
 * with a fresh random IV per value and the GCM tag as a tamper seal. The associated data — the
 * secret's place, e.g. `service:<id>:DB_PASSWORD` — binds a ciphertext to its row and field, so
 * one copied elsewhere won't decrypt.
 *
 * The key is a file of its own (MASTER_KEY_FILE): a copy of the database alone reveals nothing.
 * It must be readable by this user only — the app refuses to start otherwise. In production the
 * installer creates it; in development it is created on first start.
 */
@Injectable()
export class SecretsService implements OnModuleInit {
  private readonly logger = new Logger(SecretsService.name);
  private readonly keyFile: string;
  private readonly production: boolean;
  private key: Buffer | null = null;

  constructor(config: ConfigService<Env, true>) {
    this.keyFile = resolve(config.get('MASTER_KEY_FILE', { infer: true }));
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  async onModuleInit(): Promise<void> {
    this.key = await this.loadKey();
  }

  encrypt(plaintext: string, context: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.of(FORMAT_V1), iv, ciphertext, cipher.getAuthTag()]);
  }

  /** Throws if the value was changed, belongs elsewhere (`context`) or used another key. */
  decrypt(stored: Uint8Array, context: string): string {
    const value = Buffer.from(stored);
    if (value.length < 1 + IV_BYTES + TAG_BYTES || value[0] !== FORMAT_V1) {
      throw new Error('Unknown secret format');
    }
    const iv = value.subarray(1, 1 + IV_BYTES);
    const tag = value.subarray(value.length - TAG_BYTES);
    const ciphertext = value.subarray(1 + IV_BYTES, value.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.requireKey(), iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** A random secret for a `generatedSecret` field: letters and digits (some images refuse others). */
  generate(length = 32): string {
    let secret = '';
    for (let i = 0; i < length; i++)
      secret += GENERATED_ALPHABET[randomInt(GENERATED_ALPHABET.length)];
    return secret;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('The master key is not loaded');
    return this.key;
  }

  private async loadKey(): Promise<Buffer> {
    let info;
    try {
      info = await stat(this.keyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.production) {
        throw new Error(`The master key ${this.keyFile} can't be read (the installer creates it)`);
      }
      await this.createKey();
      info = await stat(this.keyFile);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error(
        `The master key ${this.keyFile} must be readable by its owner only (chmod 600)`,
      );
    }
    if (process.getuid && info.uid !== process.getuid()) {
      throw new Error(`The master key ${this.keyFile} must belong to the app's user`);
    }
    const key = Buffer.from((await readFile(this.keyFile, 'utf8')).trim(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(`The master key ${this.keyFile} is not 32 bytes of base64`);
    }
    return key;
  }

  /** Like the setup token: a new file created exclusively with mode 0600, renamed into place. */
  private async createKey(): Promise<void> {
    const dir = dirname(this.keyFile);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `.master-key-${randomBytes(8).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${randomBytes(KEY_BYTES).toString('base64')}\n`);
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, this.keyFile);
    this.logger.warn(`Created a development master key in ${this.keyFile}`);
  }
}
