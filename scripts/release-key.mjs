// Makes the release signing key:
//   <folder>/release.key   the private key, encrypted with a generated passphrase — keep it offline,
//                          backed up twice, the passphrase in a password manager
//   <folder>/release.pub   the public key (minisign's format) — copy it to system/install/release.pub
// Or re-protects an existing key under a new generated passphrase (the same key: installed machines
// notice nothing), from a key file of this format or the PKCS#8 PEM of earlier versions:
// Usage: npm run release:key -- <folder>
//        npm run release:key -- rewrap <old release.key> <new release.key>
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generatePassphrase, openKey, openKeyOrPem, sealKey } from './lib/key-file.mjs';
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

function generateAndShow() {
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
  let text;
  try {
    text = readFileSync(oldPath, 'utf8');
  } catch (error) {
    fail(`can't read ${oldPath}: ${error.code ?? error.message}`);
  }
  const oldSecret = await passphrase('Passphrase of the current key: ').catch((error) =>
    fail(error.message),
  );
  let privateKey;
  try {
    privateKey = openKeyOrPem(text, oldSecret);
  } catch (error) {
    fail(error.message);
  }
  // Always a new generated passphrase: rewrap is for leaving the old one behind.
  const newSecret = generateAndShow();
  writeKey(newPath, privateKey, newSecret);
  // Read back before the owner deletes the old one; a file that doesn't is removed.
  try {
    const reopened = openKey(readFileSync(newPath, 'utf8'), newSecret);
    if (publicKeyFile(reopened) !== publicKeyFile(privateKey)) throw new Error('another key');
  } catch (error) {
    rmSync(newPath, { force: true });
    fail(`${newPath} didn't read back (${error.message}); removed, the old key is unchanged`);
  }
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
  // Tests set RELEASE_KEY_PASSPHRASE to know it.
  writeKey(keyPath, privateKey, process.env.RELEASE_KEY_PASSPHRASE || generateAndShow());
  writeFileSync(pubPath, publicKeyFile(publicKey), { flag: 'wx' });
  console.log(
    `${keyPath}\n${pubPath}\n${join('system', 'install', 'release.pub')} is where the public key goes.`,
  );
}
