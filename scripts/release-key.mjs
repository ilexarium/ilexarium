// Makes the release signing key:
//   <folder>/release.key   the private key, encrypted with a passphrase — keep it offline, backed up twice
//   <folder>/release.pub   the public key (minisign's format) — copy it to system/install/release.pub
// Usage: npm run release:key -- <folder>
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { publicKeyFile } from './lib/minisign.mjs';
import { passphrase } from './lib/passphrase.mjs';

const MIN_PASSPHRASE = 12;

const folder = process.argv[2];
if (!folder) {
  console.error('usage: npm run release:key -- <folder>');
  process.exit(2);
}
const keyPath = resolve(folder, 'release.key');
const pubPath = resolve(folder, 'release.pub');
for (const path of [keyPath, pubPath]) {
  if (existsSync(path)) {
    console.error(`${path} exists — never replaced (installed machines trust that key)`);
    process.exit(1);
  }
}
const secret = await passphrase('Passphrase for the new key: ');
if (secret.length < MIN_PASSPHRASE) {
  console.error(`At least ${MIN_PASSPHRASE} characters`);
  process.exit(1);
}
if (!process.env.RELEASE_KEY_PASSPHRASE && (await passphrase('Again: ')) !== secret) {
  console.error('They differ');
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({
  type: 'pkcs8',
  format: 'pem',
  cipher: 'aes-256-cbc',
  passphrase: secret,
});
const pub = publicKeyFile(publicKey);
mkdirSync(folder, { recursive: true, mode: 0o700 });
writeFileSync(keyPath, pem, { mode: 0o600, flag: 'wx' });
writeFileSync(pubPath, pub, { flag: 'wx' });
console.log(
  `${keyPath}\n${pubPath}\n${join('system', 'install', 'release.pub')} is where the public key goes.`,
);
