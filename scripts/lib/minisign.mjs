// Writing minisign's formats (prehashed Ed25519) with node:crypto: the release key's public file
// and a file's signature. The programs and the app check them with their own code.
import { createHash, createPublicKey, sign } from 'node:crypto';

/** The key's 8-byte id: taken from the public key itself, so the private key file needs nothing else. */
export function keyIdOf(publicKey) {
  return createHash('sha256').update(rawPublicKey(publicKey)).digest().subarray(0, 8);
}

function rawPublicKey(key) {
  const jwk = (key.type === 'public' ? key : createPublicKey(key)).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

// minisign shows the id as a little-endian number in hex.
const shownId = (keyId) => Buffer.from(keyId).reverse().toString('hex').toUpperCase();

export function publicKeyFile(publicKey) {
  const keyId = keyIdOf(publicKey);
  const raw = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey(publicKey)]);
  return `untrusted comment: minisign public key ${shownId(keyId)}\n${raw.toString('base64')}\n`;
}

export function signatureFile(privateKey, data, fileName) {
  const keyId = keyIdOf(privateKey);
  const digest = createHash('blake2b512').update(data).digest();
  const signature = sign(null, digest, privateKey);
  const trusted = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${fileName}\thashed`;
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
  const raw = Buffer.concat([Buffer.from('ED'), keyId, signature]);
  return [
    `untrusted comment: signature from Ilexarium release key ${shownId(keyId)}`,
    raw.toString('base64'),
    `trusted comment: ${trusted}`,
    global.toString('base64'),
    '',
  ].join('\n');
}
