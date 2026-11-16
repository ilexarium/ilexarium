// The release key's file: the private key (PKCS#8 DER) encrypted with AES-256-GCM under a key
// scrypt derives from the passphrase. Node's own encrypted PEM stretches a passphrase with only
// 2048 PBKDF2 rounds; scrypt at 1 GiB makes each guess cost a second and the memory with it.
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const FORMAT = 'ilexarium-release-key';
export const SCRYPT_COST = { N: 2 ** 20, r: 8, p: 1 };
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 20;

const deriveKey = (passphrase, salt, { N, r, p }) =>
  scryptSync(passphrase, salt, 32, { N, r, p, maxmem: 128 * N * r + 2 ** 24 });

// The settings are the cipher's additional data: a file whose settings were changed doesn't open.
const header = ({ N, r, p, salt }) => `${FORMAT}:1:scrypt:${N}:${r}:${p}:${salt}`;

export function sealKey(privateKey, passphrase, cost = SCRYPT_COST) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const settings = { ...cost, salt: salt.toString('base64') };
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, cost), iv);
  cipher.setAAD(Buffer.from(header(settings)));
  const data = Buffer.concat([
    cipher.update(privateKey.export({ type: 'pkcs8', format: 'der' })),
    cipher.final(),
  ]);
  const file = {
    format: FORMAT,
    version: 1,
    kdf: { name: 'scrypt', ...settings },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The private key, or an Error: "wrong passphrase" also for a changed file (GCM can't tell). */
export function openKey(text, passphrase) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error(
      'not a release key file (an old PEM key? npm run release:key -- rewrap <old> <new>)',
    );
  }
  const { kdf, iv, tag, data } = file ?? {};
  const { N, r, p, salt } = kdf ?? {};
  if (
    file?.format !== FORMAT ||
    file.version !== 1 ||
    file.cipher !== 'aes-256-gcm' ||
    kdf?.name !== 'scrypt' ||
    !(Number.isInteger(N) && N >= MIN_N && N <= MAX_N) ||
    (N & (N - 1)) !== 0 ||
    r !== SCRYPT_COST.r ||
    p !== SCRYPT_COST.p ||
    ![salt, iv, tag, data].every((value) => typeof value === 'string')
  ) {
    throw new Error('not a release key file this version reads');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, Buffer.from(salt, 'base64'), { N, r, p }),
    Buffer.from(iv, 'base64'),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(header({ N, r, p, salt })));
  let der;
  try {
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    der = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  } catch {
    throw new Error('wrong passphrase');
  }
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

// For rewrap: a key file of this format, or the passphrase-encrypted PKCS#8 PEM of earlier versions.
export function openKeyOrPem(text, passphrase) {
  if (!/^\s*-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) return openKey(text, passphrase);
  try {
    return createPrivateKey({ key: text, passphrase });
  } catch {
    throw new Error('wrong passphrase');
  }
}

// 25 letters and digits from 31 (about 124 bits), in groups of five: typed rarely, kept in a password
// manager. No 0/O or 1/I/L to misread.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generatePassphrase() {
  const chars = [];
  while (chars.length < 25) {
    for (const byte of randomBytes(32)) {
      // Bytes past the last whole multiple of 31 are dropped, so each character is equally likely.
      if (byte < 248 && chars.length < 25) chars.push(ALPHABET[byte % 31]);
    }
  }
  return chars.join('').match(/.{5}/g).join('-');
}
