// A release's manifest as the release scripts write it (scripts/lib/manifest.mjs), read by each of
// its readers: get-ilex.sh line by line, ilex-update and the app as JSON. Run by the server's unit
// tests.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestFile } from '../../scripts/lib/manifest.mjs';
import * as appManifest from '../../apps/server/src/updates/release-manifest.ts';
import * as updateRelease from './update/release.mts';

const GET_ILEX = join(import.meta.dirname, '../install/get-ilex.sh');
const ARCHIVE = Buffer.from('an archive');
const SHA256 = '9e691d5adacf0e102f203100842ffaba4e2a7dfe3dbd536827d3c0db8c7e88f1';
const PUBLISHED = new Date('2026-11-20T10:00:00.123Z');

const written = (notes: boolean) =>
  manifestFile({ version: '0.3.0', archive: ARCHIVE, notes, published: PUBLISHED }).toString();
const fields = {
  version: '0.3.0',
  published: '2026-11-20T10:00:00Z',
  archive: 'ilex-0.3.0.tar.gz',
  sha256: SHA256,
  size: 10,
};
const { size, ...withoutSize } = fields;
const asWritten = (manifest: unknown) => `${JSON.stringify(manifest, null, 2)}\n`;
const READ = { version: '0.3.0', archive: 'ilex-0.3.0.tar.gz', sha256: SHA256, size: '10' };

describe('the release manifest', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ilex-manifest-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // get-ilex.sh's own field() and read_manifest(), run on their own: the script's other steps
  // download.
  function getIlex(manifest: string): Record<string, string> | 'malformed' {
    writeFileSync(join(dir, 'latest.json'), manifest);
    const script = `set -euo pipefail
      WORK="$2"
      eval "$(sed -n '/^field() {/,/^}/p; /^read_manifest() {/,/^}/p' "$1")"
      if read_manifest; then printf '%s\\n' "$version" "$archive" "$sha256" "$size"; else echo malformed; fi`;
    const out = execFileSync('bash', ['-c', script, 'bash', GET_ILEX, dir], {
      env: { PATH: process.env['PATH'] },
      encoding: 'utf8',
    });
    if (out === 'malformed\n') return 'malformed';
    const [version, archive, sha256, size] = out.split('\n');
    return { version: version!, archive: archive!, sha256: sha256!, size: size! };
  }

  it('is written one field per line, the notes last', () => {
    expect(written(true)).toBe(`{
  "version": "0.3.0",
  "published": "2026-11-20T10:00:00Z",
  "archive": "ilex-0.3.0.tar.gz",
  "sha256": "${SHA256}",
  "size": 10,
  "notes": "NOTES.md"
}
`);
    expect(written(false)).toBe(written(true).replace(',\n  "notes": "NOTES.md"', ''));
  });

  it.each([
    ['without notes', false, fields],
    ['with notes', true, { ...fields, notes: 'NOTES.md' }],
  ])('is read the same by get-ilex.sh, ilex-update and the app %s', (_, notes, parsed) => {
    expect(getIlex(written(notes))).toEqual(READ);
    expect(updateRelease.parseManifest(written(notes))).toEqual(parsed);
    expect(appManifest.parseManifest(written(notes))).toEqual(parsed);
  });

  it('get-ilex.sh reads the fields in any order and passes over keys it does not know', () => {
    expect(getIlex(asWritten({ size, notes: 'NOTES.md', ...withoutSize }))).toEqual(READ);
    expect(getIlex(asWritten({ ...fields, minimum: '0.2.0', more: { size: 1 } }))).toEqual(READ);
  });

  it.each([
    ['the size as a string', asWritten({ ...fields, size: '10' })],
    ['the version as a number', asWritten({ ...fields, version: 3 })],
    ['a space after the size', written(true).replace('"size": 10,', '"size": 10 ,')],
    ['more after the size', written(true).replace('"size": 10,', '"size": 10, "x": 1,')],
    ['more after the sha256', written(true).replace(`${SHA256}",`, `${SHA256}", "x": "y",`)],
    ['a size given twice', written(false).replace('"size": 10', '"size": 10,\n  "size": 11')],
    ['the size inside another key', asWritten({ ...withoutSize, more: { size: 10 } })],
    ['the size inside a string', asWritten({ ...withoutSize, notes: 'x\n  "size": 10,' })],
    ['everything on one line', JSON.stringify(fields)],
    ['an empty file', ''],
  ])('get-ilex.sh refuses %s', (_, manifest) => {
    expect(getIlex(manifest)).toBe('malformed');
  });
});
