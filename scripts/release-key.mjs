// Makes the release signing key:
//   <folder>/release.key   the private key, encrypted with a generated passphrase — keep it offline,
//                          backed up twice, the passphrase in a password manager
//   <folder>/release.pub   the public key (minisign's format) — copy it to system/install/release.pub
// Or re-protects an existing key under a new generated passphrase (the same key: installed machines
// notice nothing), from a key file of this format or the PKCS#8 PEM of earlier versions:
// Usage: npm run release:key -- <folder>
//        npm run release:key -- rewrap <old release.key> <new release.key>
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generatePassphrase, openKey, sealKey } from './lib/key-file.mjs';
import { publicKeyFile } from './lib/minisign.mjs';
import { passphrase } from './lib/passphrase.mjs';

const USAGE =
  'usage: npm run release:key -- <folder>\n       npm run release:key -- rewrap <old> <new>';
const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};
const refuseExisting = (path) => {
  if (existsSync(path)) fail(`${path} exists — never replaced`);
};

// Tests set RELEASE_KEY_PASSPHRASE to know it; otherwise it's generated and shown once.
function newPassphrase() {
  const fromEnv = process.env.RELEASE_KEY_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const secret = generatePassphrase();
  console.log(
    `\nThe key's passphrase — put it in your password manager now; it isn't shown again:\n\n  ${secret}\n`,
  );
  return secret;
}

function writeKey(path, privateKey, secret) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, sealKey(privateKey, secret), { mode: 0o600, flag: 'wx' });
}

const [first, ...rest] = process.argv.slice(2);
if (first === 'rewrap') {
  if (rest.length !== 2) fail(USAGE, 2);
  const [oldPath, newPath] = rest.map((path) => resolve(path));
  refuseExisting(newPath);
  const text = readFileSync(oldPath, 'utf8');
  const oldSecret = await passphrase('Passphrase of the current key: ').catch((error) =>
    fail(error.message),
  );
  let privateKey;
  try {
    privateKey = text.startsWith('-----BEGIN')
      ? createPrivateKey({ key: text, passphrase: oldSecret })
      : openKey(text, oldSecret);
  } catch {
    fail('wrong passphrase');
  }
  const newSecret = newPassphrase();
  writeKey(newPath, privateKey, newSecret);
  // Read back before the owner deletes the old one.
  const reopened = openKey(readFileSync(newPath, 'utf8'), newSecret);
  if (publicKeyFile(reopened) !== publicKeyFile(privateKey)) fail(`${newPath} didn't read back`);
  console.log(
    `${newPath}: the same key, ${publicKeyFile(privateKey).split('\n')[0].split(' ').pop()}`,
  );
  console.log('Point release-settings.json at it, then delete the old file and its backups.');
} else {
  if (!first || rest.length) fail(USAGE, 2);
  const keyPath = resolve(first, 'release.key');
  const pubPath = resolve(first, 'release.pub');
  [keyPath, pubPath].forEach(refuseExisting);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeKey(keyPath, privateKey, newPassphrase());
  writeFileSync(pubPath, publicKeyFile(publicKey), { flag: 'wx' });
  console.log(
    `${keyPath}\n${pubPath}\n${join('system', 'install', 'release.pub')} is where the public key goes.`,
  );
}
