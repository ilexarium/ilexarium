import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

// minisign's format, prehashed Ed25519 (the signature covers the file's BLAKE2b-512) — the app's
// own copy; ilex-update has its own (system/programs/lib/minisign.mts), get-ilex.sh uses openssl.

const PUBLIC_KEY_BYTES = 42;
const SIGNATURE_BYTES = 74;
const GLOBAL_SIGNATURE_BYTES = 64;
const TRUSTED_PREFIX = 'trusted comment: ';

export interface ReleaseKey {
  keyId: Buffer;
  key: KeyObject;
}

// Strict base64: Buffer.from would skip what it doesn't understand.
function decode(text: string, bytes: number): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const decoded = Buffer.from(text, 'base64');
  return decoded.length === bytes ? decoded : null;
}

function lines(text: string): string[] {
  const all = text.split('\n').map((line) => line.replace(/\r$/, ''));
  if (all.at(-1) === '') all.pop();
  return all;
}

export function parseReleaseKey(text: string): ReleaseKey | null {
  const [comment, encoded, ...rest] = lines(text);
  if (!comment?.startsWith('untrusted comment: ') || encoded === undefined || rest.length > 0) {
    return null;
  }
  const raw = decode(encoded, PUBLIC_KEY_BYTES);
  if (!raw || raw.subarray(0, 2).toString('latin1') !== 'Ed') return null;
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10).toString('base64url') },
    format: 'jwk',
  });
  return { keyId: raw.subarray(2, 10), key };
}

/** Whether `signature` (a .minisig file) is the key's signature of `data`, trusted comment included. */
export function verifyRelease(releaseKey: ReleaseKey, signature: string, data: Buffer): boolean {
  const all = lines(signature);
  if (all.length !== 4) return false;
  const [comment, encoded, trusted, encodedGlobal] = all as [string, string, string, string];
  if (!comment.startsWith('untrusted comment: ') || !trusted.startsWith(TRUSTED_PREFIX)) {
    return false;
  }
  const raw = decode(encoded, SIGNATURE_BYTES);
  const global = decode(encodedGlobal, GLOBAL_SIGNATURE_BYTES);
  if (!raw || !global) return false;
  if (raw.subarray(0, 2).toString('latin1') !== 'ED') return false;
  if (!raw.subarray(2, 10).equals(releaseKey.keyId)) return false;
  const signatureBytes = raw.subarray(10);
  const digest = createHash('blake2b512').update(data).digest();
  if (!verify(null, digest, releaseKey.key, signatureBytes)) return false;
  const trustedComment = Buffer.from(trusted.slice(TRUSTED_PREFIX.length), 'utf8');
  return verify(null, Buffer.concat([signatureBytes, trustedComment]), releaseKey.key, global);
}
