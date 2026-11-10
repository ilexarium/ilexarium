import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicKeyFile, signatureFile } from '../../../../scripts/lib/minisign.mjs';
import { ReleaseCheck } from './release-check.js';
import type { UpdatePlaces } from './update-places.js';

const key = generateKeyPairSync('ed25519');
let server: Server;
let port: number;
let files: Map<string, { status?: number; body?: string; location?: string }>;
let dir: string;

function serve(manifest: object, signedBy: KeyObject = key.privateKey, notes?: string) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  files.set('/r/latest/download/latest.json', { body: bytes.toString() });
  files.set('/r/latest/download/latest.json.minisig', {
    body: signatureFile(signedBy, bytes, 'manifest.json'),
  });
  if (notes !== undefined) files.set('/r/download/v0.2.0/NOTES.md', { body: notes });
}

const manifest = {
  version: '0.2.0',
  published: '2026-11-20T10:00:00Z',
  archive: 'ilex-0.2.0.tar.gz',
  sha256: 'a'.repeat(64),
  size: 1000,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const file = files.get(req.url ?? '');
    if (file?.location) res.setHeader('location', file.location);
    res.statusCode = file ? (file.status ?? 200) : 404;
    res.end(file?.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

beforeEach(() => {
  files = new Map();
  dir = mkdtempSync(join(tmpdir(), 'release-check-'));
  writeFileSync(join(dir, 'release.env'), `RELEASE_URL=http://127.0.0.1:${port}/r\nHTTPS=none\n`);
  writeFileSync(join(dir, 'release.pub'), publicKeyFile(key.publicKey));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const check = (development = true) =>
  new ReleaseCheck({ settingsDir: dir, development } as UpdatePlaces);

async function newest() {
  const releaseCheck = check();
  return releaseCheck.newest((await releaseCheck.source())!);
}

describe('ReleaseCheck', () => {
  it('finds the newest release, signed by the installed key, with its notes as text', async () => {
    serve(
      { ...manifest, notes: 'NOTES.md' },
      key.privateKey,
      'Faster backups.\n\u001b[31mred\u001b[0m\n',
    );
    expect(await newest()).toEqual({
      ok: true,
      newest: { ...manifest, notes: 'NOTES.md' },
      notes: 'Faster backups.\n[31mred[0m',
    });
  });

  it('refuses a notice signed by another key', async () => {
    serve(manifest, generateKeyPairSync('ed25519').privateKey);
    expect(await newest()).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('refuses a signed manifest that names an address', async () => {
    serve({ ...manifest, archive: 'https://elsewhere/ilex-0.2.0.tar.gz' });
    expect(await newest()).toEqual({ ok: false, error: 'bad_manifest' });
  });

  it('a folder that doesn’t answer, or a redirect away from HTTPS, is unreachable', async () => {
    expect(await newest()).toEqual({ ok: false, error: 'unreachable' });
    files.set('/r/latest/download/latest.json', { status: 302, location: 'http://example.com/x' });
    files.set('/r/latest/download/latest.json.minisig', { body: 'x' });
    expect(await newest()).toEqual({ ok: false, error: 'unreachable' });
  });

  it('follows a redirect the signature then decides on', async () => {
    serve(manifest);
    files.set('/r/latest/download/latest.json', {
      status: 302,
      location: `http://127.0.0.1:${port}/elsewhere/latest.json`,
    });
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    files.set('/elsewhere/latest.json', { body: bytes.toString() });
    expect((await newest()).ok).toBe(true);
  });

  it('no source: no release.pub, or an http:// address outside development', async () => {
    rmSync(join(dir, 'release.pub'));
    expect(await check().source()).toBeNull();
    writeFileSync(join(dir, 'release.pub'), publicKeyFile(key.publicKey));
    expect(await check(false).source()).toBeNull();
    expect(await check(true).source()).not.toBeNull();
  });
});
