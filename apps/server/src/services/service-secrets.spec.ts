import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { CatalogEntry } from '../catalog/catalog.model.js';
import type { Env } from '../config/env.schema.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { ServiceSecrets } from './service-secrets.js';

const entry = {
  meta: {
    fields: [
      { key: 'WEB_PORT', type: 'port', default: 8080 },
      { key: 'ADMIN_PASSWORD', type: 'secret' },
      { key: 'DB_PASSWORD', type: 'generatedSecret' },
    ],
  },
} as unknown as CatalogEntry;

let dir: string;
let secrets: SecretsService;
let serviceSecrets: ServiceSecrets;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'service-secrets-'));
  const config = {
    get: (name: string) => (name === 'MASTER_KEY_FILE' ? join(dir, 'master.key') : 'test'),
  } as unknown as ConfigService<Env, true>;
  secrets = new SecretsService(config);
  await secrets.onModuleInit();
  serviceSecrets = new ServiceSecrets(secrets);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ServiceSecrets', () => {
  it('splits plain settings from secrets: entered as given, generated when new', () => {
    const { settings, secretValues } = serviceSecrets.resolve(
      entry,
      { WEB_PORT: 8080, ADMIN_PASSWORD: 'correct horse battery' },
      null,
    );
    expect(settings).toEqual({ WEB_PORT: 8080 });
    expect(secretValues.ADMIN_PASSWORD).toBe('correct horse battery');
    expect(secretValues.DB_PASSWORD).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it('reuses a previous install’s secrets: the generated one always, the entered one if left empty', () => {
    const rows = serviceSecrets.rows('s1', {
      ADMIN_PASSWORD: 'old admin pass',
      DB_PASSWORD: 'Db1'.repeat(8),
    });
    const previous = { serviceId: 's1', values: new Map(rows.map((r) => [r.key, r.value])) };
    const kept = serviceSecrets.resolve(entry, { WEB_PORT: 8080, ADMIN_PASSWORD: '' }, previous);
    expect(kept.secretValues).toEqual({
      ADMIN_PASSWORD: 'old admin pass',
      DB_PASSWORD: 'Db1'.repeat(8),
    });
    const changed = serviceSecrets.resolve(
      entry,
      { WEB_PORT: 8080, ADMIN_PASSWORD: 'a new admin pass' },
      previous,
    );
    expect(changed.secretValues.ADMIN_PASSWORD).toBe('a new admin pass');
    expect(changed.secretValues.DB_PASSWORD).toBe('Db1'.repeat(8));
  });

  it('encrypts each row bound to its service and field', () => {
    const [row] = serviceSecrets.rows('s1', { DB_PASSWORD: 'secret-value' });
    expect(Buffer.from(row.value).includes(Buffer.from('secret-value'))).toBe(false);
    expect(secrets.decrypt(row.value, 'service:s1:DB_PASSWORD')).toBe('secret-value');
    expect(() => secrets.decrypt(row.value, 'service:s2:DB_PASSWORD')).toThrow();
  });

  it('names the entered secrets a previous install has (generated ones are never asked)', () => {
    expect(serviceSecrets.keptKeys(entry, ['ADMIN_PASSWORD', 'DB_PASSWORD'])).toEqual([
      'ADMIN_PASSWORD',
    ]);
  });
});
