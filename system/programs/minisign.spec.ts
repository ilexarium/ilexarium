// Release signatures in minisign's format: written by the release scripts (scripts/lib/), checked
// by the programs (lib/minisign.mts), the app (updates/release-signature.ts) and get-ilex.sh
// (openssl). Run by the server's unit tests.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicKeyFile, signatureFile } from '../../scripts/lib/minisign.mjs';
import { parseReleaseKey, verifyRelease } from '../../apps/server/src/updates/release-signature.ts';
import { parsePublicKey, verifySignature } from './lib/minisign.mts';

const GET_ILEX = join(import.meta.dirname, '../install/get-ilex.sh');
const DATA = Buffer.from('{\n  "version": "1.2.3"\n}\n');

function keys(): { privateKey: KeyObject; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKeyFile(publicKey) };
}

const { privateKey, pub } = keys();
const good = signatureFile(privateKey, DATA, 'manifest.json');
const [comment, encoded, trusted, global] = good.split('\n') as [string, string, string, string];

function withLine(index: number, line: string): string {
  const all = good.split('\n');
  all[index] = line;
  return all.join('\n');
}

function signatureBytes(): Buffer {
  return Buffer.from(encoded, 'base64');
}

// The legacy form signs the file itself, not its hash.
const legacy = (() => {
  const raw = signatureBytes();
  const signature = sign(null, DATA, privateKey);
  const bytes = Buffer.concat([Buffer.from('Ed'), raw.subarray(2, 10), signature]);
  return withLine(1, bytes.toString('base64'));
})();

const otherKeyId = (() => {
  const raw = signatureBytes();
  raw[2] = raw[2]! ^ 1;
  return withLine(1, raw.toString('base64'));
})();

const bad: [string, string, Buffer][] = [
  ['changed data', good, Buffer.from('{\n  "version": "9.9.9"\n}\n')],
  ['another key', signatureFile(keys().privateKey, DATA, 'manifest.json'), DATA],
  ['another key id', otherKeyId, DATA],
  ['the legacy form', legacy, DATA],
  ['a changed trusted comment', withLine(2, `${trusted}x`), DATA],
  ['a missing global signature', [comment, encoded, trusted, ''].join('\n'), DATA],
  ['a broken global signature', withLine(3, `A${global.slice(1)}`), DATA],
  ['not base64', withLine(1, `${encoded.slice(0, -4)}!!!!`), DATA],
  ['an extra line', `${good}more\n`, DATA],
  ['no comment', withLine(0, 'comment: x'), DATA],
  ['empty', '', DATA],
];

describe.each([
  ['the programs', parsePublicKey, verifySignature],
  ['the app', parseReleaseKey, verifyRelease],
] as const)('release signatures (%s)', (_, parse, check) => {
  const key = parse(pub)!;

  it('accepts a signature by the key', () => {
    expect(check(key, good, DATA)).toBe(true);
    expect(check(key, good.replaceAll('\n', '\r\n'), DATA)).toBe(true);
  });

  it.each(bad)('refuses %s', (_, signature, data) => {
    expect(check(key, signature, data)).toBe(false);
  });

  it('reads only minisign public keys', () => {
    expect(parse('')).toBeNull();
    expect(parse(pub.split('\n')[1]!)).toBeNull();
    expect(parse(`${pub}extra\n`)).toBeNull();
    expect(parse(pub.replace('RW', 'RX'))).toBeNull();
  });
});

describe('release signatures (get-ilex.sh)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ilex-minisign-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // get-ilex.sh's own verify(), run on its own: the script's other steps download.
  function check(signature: string, data: Buffer, publicKey = pub): boolean {
    writeFileSync(join(dir, 'file'), data);
    writeFileSync(join(dir, 'file.minisig'), signature);
    const script = `set -euo pipefail
      WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
      bytes() { wc -c <"$1" | tr -d ' '; }
      eval "$(sed -n '/^verify() {/,/^}/p' "$1")"
      if verify "$2" "$3"; then echo yes; else echo no; fi`;
    const out = execFileSync(
      'bash',
      ['-c', script, 'bash', GET_ILEX, join(dir, 'file'), join(dir, 'file.minisig')],
      {
        env: { PATH: process.env['PATH'], PUBLIC_KEY: publicKey.split('\n')[1] },
        encoding: 'utf8',
      },
    );
    return out.trim() === 'yes';
  }

  it('accepts a signature by the key', () => {
    expect(check(good, DATA)).toBe(true);
  });

  // The untrusted comment is covered by no signature: only the programs insist on its form.
  it.each(bad.filter(([name]) => name !== 'no comment'))('refuses %s', (_, signature, data) => {
    expect(check(signature, data)).toBe(false);
  });

  it('refuses a signature by the right key id with another key', () => {
    expect(check(good, DATA, keys().pub)).toBe(false);
  });
});
