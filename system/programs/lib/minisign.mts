// Checks a file signed in minisign's format (prehashed Ed25519: the signature covers the file's
// BLAKE2b-512), with node:crypto alone — the programs' own copy; the app has its own.

import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

const PUBLIC_KEY_BYTES = 42;
const SIGNATURE_BYTES = 74;
const GLOBAL_SIGNATURE_BYTES = 64;
const TRUSTED_PREFIX = 'trusted comment: ';

export interface PublicKey {
  keyId: Buffer;
  key: KeyObject;
}

// Strict base64: Buffer.from would skip anything it doesn't understand.
function decode(text: string, bytes: number): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const decoded = Buffer.from(text, 'base64');
  return decoded.length === bytes ? decoded : null;
}

function lines(text: string): string[] {
  const all = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (all.at(-1) === '') all.pop();
  return all;
}

/** The public key in minisign's file format (an untrusted comment, then the key), or null. */
export function parsePublicKey(text: string): PublicKey | null {
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

/**
 * Whether `signature` (a .minisig file's text) is `publicKey`'s signature of `data`, its trusted
 * comment included. Anything malformed is simply not a valid signature.
 */
export function verifySignature(publicKey: PublicKey, signature: string, data: Buffer): boolean {
  const all = lines(signature);
  if (all.length !== 4) return false;
  const [comment, encoded, trusted, encodedGlobal] = all as [string, string, string, string];
  if (!comment.startsWith('untrusted comment: ') || !trusted.startsWith(TRUSTED_PREFIX)) {
    return false;
  }
  const raw = decode(encoded, SIGNATURE_BYTES);
  const global = decode(encodedGlobal, GLOBAL_SIGNATURE_BYTES);
  if (!raw || !global) return false;
  // Only the prehashed form: the legacy one ("Ed") signs the whole file in memory.
  if (raw.subarray(0, 2).toString('latin1') !== 'ED') return false;
  if (!raw.subarray(2, 10).equals(publicKey.keyId)) return false;
  const signatureBytes = raw.subarray(10);
  const digest = createHash('blake2b512').update(data).digest();
  if (!verify(null, digest, publicKey.key, signatureBytes)) return false;
  const trustedComment = Buffer.from(trusted.slice(TRUSTED_PREFIX.length), 'utf8');
  return verify(null, Buffer.concat([signatureBytes, trustedComment]), publicKey.key, global);
}
