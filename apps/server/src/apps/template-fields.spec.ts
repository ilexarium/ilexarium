import type { Template } from '@laris/shared';
import { templateFields } from './template-fields.js';

const context = { account: '1500:1500', timezone: 'Europe/Berlin' };
const template = {
  id: 'demo',
  fields: [
    { key: 'USER_ID', kind: 'text', default: '@account', advanced: true },
    { key: 'TZ', kind: 'text', default: '@timezone' },
    { key: 'DB_PASSWORD', kind: 'generated' },
    { key: 'PORT', kind: 'port', default: 8080 },
    { key: 'MEDIA', kind: 'folder' },
  ],
} as unknown as Template;

describe('templateFields', () => {
  it('one field per template field: kinds from it, @account and @timezone filled, secrets made', () => {
    const fields = templateFields(template, '', context);
    expect(fields.map((f) => [f.key, f.kind, f.value, f.default, f.required, f.advanced])).toEqual([
      ['USER_ID', 'text', '1500:1500', '1500:1500', false, true],
      ['TZ', 'text', 'Europe/Berlin', 'Europe/Berlin', false, false],
      ['DB_PASSWORD', 'generated', expect.stringMatching(/^[A-Za-z0-9_-]{32}$/), null, true, false],
      ['PORT', 'port', '8080', '8080', false, false],
      ['MEDIA', 'folder', '', null, true, false],
    ]);
  });

  it('values come from .env first; a secret there is kept', () => {
    const fields = templateFields(template, 'PORT=9000\nDB_PASSWORD=kept\n', context);
    expect(fields.find((f) => f.key === 'PORT')).toMatchObject({ value: '9000', default: '8080' });
    expect(fields.find((f) => f.key === 'DB_PASSWORD')?.value).toBe('kept');
  });

  it('before a Linux sign-in, @account is empty (filled at install)', () => {
    const fields = templateFields(template, '', { ...context, account: '' });
    expect(fields[0]).toMatchObject({ value: '', default: '' });
  });
});
