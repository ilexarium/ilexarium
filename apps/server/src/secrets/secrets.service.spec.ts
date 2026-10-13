import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { SecretsService } from './secrets.service.js';

let dir: string;

async function service(keyFile = join(dir, 'master.key'), env: Env['NODE_ENV'] = 'test') {
  const config = {
    get: (name: string) => (name === 'MASTER_KEY_FILE' ? keyFile : env),
  } as unknown as ConfigService<Env, true>;
  const secrets = new SecretsService(config);
  await secrets.onModuleInit();
  return secrets;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'secrets-'));
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe('SecretsService', () => {
  it('round-trips a secret, with a fresh IV every time', async () => {
    const secrets = await service();
    const a = secrets.encrypt('p@$$w0rd ü', 'service:1:DB_PASSWORD');
    const b = secrets.encrypt('p@$$w0rd ü', 'service:1:DB_PASSWORD');
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('p@$$w0rd'))).toBe(false);
    expect(secrets.decrypt(a, 'service:1:DB_PASSWORD')).toBe('p@$$w0rd ü');
    expect(a[0]).toBe(1); // format version
  });

  it('refuses a changed value (the GCM seal)', async () => {
    const secrets = await service();
    const value = secrets.encrypt('secret', 'service:1:X');
    for (const at of [0, 1, 13, value.length - 1]) {
      const changed = Buffer.from(value);
      changed[at] ^= 0x01;
      expect(() => secrets.decrypt(changed, 'service:1:X'), `byte ${at}`).toThrow();
    }
  });

  it('refuses a value copied to another row or field (the associated data)', async () => {
    const secrets = await service();
    const value = secrets.encrypt('secret', 'service:1:ADMIN_PASSWORD');
    expect(() => secrets.decrypt(value, 'service:2:ADMIN_PASSWORD')).toThrow();
    expect(() => secrets.decrypt(value, 'service:1:DB_PASSWORD')).toThrow();
  });

  it('refuses a value made with another key', async () => {
    const value = (await service()).encrypt('secret', 'c');
    const other = await service(join(dir, 'other.key'));
    expect(() => other.decrypt(value, 'c')).toThrow();
  });

  it('creates a private key file in development, and reuses it', async () => {
    const keyFile = join(dir, 'keys', 'master.key');
    const first = await service(keyFile);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect(Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'base64')).toHaveLength(32);
    const value = first.encrypt('kept', 'c');
    expect((await service(keyFile)).decrypt(value, 'c')).toBe('kept');
  });

  it('never creates a key in production: the installer does', async () => {
    await expect(service(join(dir, 'missing.key'), 'production')).rejects.toThrow(/installer/);
  });

  it('refuses a key others can read', async () => {
    const keyFile = join(dir, 'loose.key');
    await writeFile(keyFile, randomBytes(32).toString('base64'), { mode: 0o644 });
    await chmod(keyFile, 0o644);
    await expect(service(keyFile)).rejects.toThrow(/owner only/);
  });

  it('refuses a key of the wrong size', async () => {
    const keyFile = join(dir, 'short.key');
    await writeFile(keyFile, randomBytes(16).toString('base64'), { mode: 0o600 });
    await expect(service(keyFile)).rejects.toThrow(/32 bytes/);
  });

  it('generates letters-and-digits secrets', async () => {
    const secrets = await service();
    const generated = secrets.generate();
    expect(generated).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(secrets.generate()).not.toBe(generated);
  });
});
