// Signs a built release: writes release/v<version>/ with the
// files as they're published — the archive, manifest.json, its signature, NOTES.md.
// Usage: npm run release:sign -- --key <release.key> [--notes <file.md>] [--allow-key-change]
//        [--version <x.y.z>] (another than package.json's: a release repacked by the install test)
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parsePublicKey, verifySignature } from '../system/programs/lib/minisign.mts';
import { manifestFile } from './lib/manifest.mjs';
import { publicKeyFile, signatureFile } from './lib/minisign.mjs';
import { passphrase } from './lib/passphrase.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    key: { type: 'string' },
    notes: { type: 'string' },
    'allow-key-change': { type: 'boolean', default: false },
    version: { type: 'string' },
  },
});
if (!values.key) {
  console.error('usage: npm run release:sign -- --key <release.key> [--notes <file.md>]');
  process.exit(2);
}
const version =
  values.version ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const archiveName = `ilex-${version}.tar.gz`;
const archive = join(ROOT, 'release', archiveName);
if (!existsSync(archive)) {
  console.error(`${relative(ROOT, archive)} not found (npm run release builds it)`);
  process.exit(1);
}

const privateKey = createPrivateKey({
  key: readFileSync(values.key),
  passphrase: await passphrase('Passphrase of the release key: '),
});
const publicFile = publicKeyFile(privateKey);
// The release carries the key machines will trust from now on: normally this very key. A new one
// arrives only signed by the old (key rotation) — on purpose, never by mistake.
const shipped = execFileSync('tar', ['-xzOf', archive, `ilex-${version}/release.pub`], {
  encoding: 'utf8',
});
if (shipped !== publicFile && !values['allow-key-change']) {
  console.error(
    'The release carries a different public key than this one (--allow-key-change if that is the rotation)',
  );
  process.exit(1);
}

const out = join(ROOT, 'release', `v${version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(archive, join(out, archiveName));
if (values.notes) copyFileSync(values.notes, join(out, 'NOTES.md'));
const manifestBytes = manifestFile({
  version,
  archive: readFileSync(archive),
  notes: Boolean(values.notes),
});
const signature = signatureFile(privateKey, manifestBytes, 'manifest.json');
if (!verifySignature(parsePublicKey(publicFile), signature, manifestBytes)) {
  throw new Error('The new signature does not check out');
}
writeFileSync(join(out, 'manifest.json'), manifestBytes);
writeFileSync(join(out, 'manifest.json.minisig'), signature);
console.log(`${relative(ROOT, out)}/ — publish it: npm run release:publish -- <folder>`);
