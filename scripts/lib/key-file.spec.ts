// The release key's file: scrypt + AES-256-GCM, the same key back with the right passphrase only.
import { generateKeyPairSync } from 'node:crypto';
import { generatePassphrase, openKey, sealKey, SCRYPT_COST } from './key-file.mjs';
import { publicKeyFile } from './minisign.mjs';

// The real cost takes a second and 1 GiB; the format is the same at a lower one.
const LOW = { N: 2 ** 14, r: 8, p: 1 };
const { privateKey } = generateKeyPairSync('ed25519');
const sealed = sealKey(privateKey, 'right', LOW);

describe('the release key file', () => {
  it('opens to the same key with its passphrase', () => {
    expect(publicKeyFile(openKey(sealed, 'right'))).toBe(publicKeyFile(privateKey));
  });

  it('holds no part of the key in the clear', () => {
    const der = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    expect(sealed).not.toContain(der.slice(-43));
    expect(JSON.parse(sealed)).toMatchObject({
      format: 'ilexarium-release-key',
      cipher: 'aes-256-gcm',
      kdf: { name: 'scrypt', N: 2 ** 14, r: 8, p: 1 },
    });
  });

  it('refuses a wrong passphrase', () => {
    expect(() => openKey(sealed, 'wrong')).toThrow('wrong passphrase');
  });

  it('refuses a file whose settings or data were changed', () => {
    const file = JSON.parse(sealed);
    const withCost = JSON.stringify({ ...file, kdf: { ...file.kdf, r: 9 } });
    expect(() => openKey(withCost, 'right')).toThrow('wrong passphrase');
    const data = Buffer.from(file.data, 'base64');
    data[0] ^= 1;
    const withData = JSON.stringify({ ...file, data: data.toString('base64') });
    expect(() => openKey(withData, 'right')).toThrow('wrong passphrase');
    const shortTag = JSON.stringify({ ...file, tag: file.tag.slice(0, 8) });
    expect(() => openKey(shortTag, 'right')).toThrow('wrong passphrase');
  });

  it('refuses a cost it would not write and settings it does not know', () => {
    const file = JSON.parse(sealed);
    for (const kdf of [
      { ...file.kdf, N: 2 ** 10 },
      { ...file.kdf, N: 2 ** 21 },
      { ...file.kdf, N: 3 * 2 ** 14 },
      { ...file.kdf, name: 'pbkdf2' },
      undefined,
    ]) {
      expect(() => openKey(JSON.stringify({ ...file, kdf }), 'right')).toThrow(
        'not a release key file',
      );
    }
    expect(() => openKey('null', 'right')).toThrow('not a release key file');
    expect(() => openKey(JSON.stringify({ ...file, iv: 1 }), 'right')).toThrow(
      'not a release key file',
    );
  });

  it('points an old PEM key to rewrap', () => {
    const pem = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'right',
    });
    expect(() => openKey(pem as string, 'right')).toThrow('rewrap');
  });

  it('writes at the full cost by default', () => {
    expect(SCRYPT_COST).toEqual({ N: 2 ** 20, r: 8, p: 1 });
  });
});

describe('generatePassphrase', () => {
  it('is five groups of five unambiguous letters and digits, new every time', () => {
    const made = Array.from({ length: 50 }, generatePassphrase);
    for (const secret of made)
      expect(secret).toMatch(/^[a-hjkmnp-z2-9]{5}(-[a-hjkmnp-z2-9]{5}){4}$/);
    expect(new Set(made).size).toBe(50);
  });
});
