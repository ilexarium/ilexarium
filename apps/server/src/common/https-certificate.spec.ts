import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCertificate } from './https-certificate.js';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/tls/', import.meta.url));
const CERT = join(FIXTURES, 'cert.pem');
const KEY = join(FIXTURES, 'key.pem');

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ilex-tls-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readCertificate', () => {
  it('the certificate and its key', async () => {
    const { cert, key } = await readCertificate(CERT, KEY);
    expect(cert.toString()).toContain('BEGIN CERTIFICATE');
    expect(key.toString()).toContain('PRIVATE KEY');
  });

  it('a missing file: names it and says what to do', async () => {
    await expect(readCertificate(join(dir, 'cert.pem'), KEY)).rejects.toThrow(
      new RegExp(`${dir}/cert.pem could not be read \\(ENOENT\\)\\. The installer makes one`),
    );
  });

  it('a key that isn’t the certificate’s, or not a key at all', async () => {
    const other = join(dir, 'other.pem');
    writeFileSync(
      other,
      generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
    );
    await expect(readCertificate(CERT, other)).rejects.toThrow(
      /are not a certificate and its key .*systemctl restart ilex/,
    );
    writeFileSync(join(dir, 'junk.pem'), 'not a key');
    await expect(readCertificate(CERT, join(dir, 'junk.pem'))).rejects.toThrow(
      /are not a certificate and its key/,
    );
  });
});
