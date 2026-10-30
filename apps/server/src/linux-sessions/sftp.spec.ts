import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sftp } from './sftp.js';
import { fakeSftp } from './testing.js';

let dir: string;
let sftp: Sftp;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sftp-'));
  sftp = new Sftp(fakeSftp());
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Sftp', () => {
  it('reads a part of a file from a byte on; null when it is missing', async () => {
    writeFileSync(join(dir, 'log'), '0123456789');
    expect((await sftp.read(join(dir, 'log'), 4, 3))?.toString()).toBe('3456');
    expect((await sftp.read(join(dir, 'log'), 100, 8))?.toString()).toBe('89');
    expect(await sftp.read(join(dir, 'gone'), 4)).toBeNull();
  });

  it('a text file whole, refused past its limit', async () => {
    writeFileSync(join(dir, 'a'), 'hello');
    expect(await sftp.readText(join(dir, 'a'), 5)).toBe('hello');
    await expect(sftp.readText(join(dir, 'a'), 4)).rejects.toMatchObject({
      response: { code: 'file_too_large' },
    });
    expect(await sftp.readText(join(dir, 'gone'), 5)).toBeNull();
  });

  it('writes whole with its mode, over what was there', async () => {
    writeFileSync(join(dir, '.env'), 'old');
    await sftp.writeText(join(dir, '.env'), 'new', 0o600);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('new');
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  });

  it('lists a folder (none: empty); stat and exists say what’s missing', async () => {
    writeFileSync(join(dir, 'x'), '');
    expect(await sftp.list(dir)).toEqual(['x']);
    expect(await sftp.list(join(dir, 'gone'))).toEqual([]);
    expect(await sftp.statOrNull(join(dir, 'gone'))).toBeNull();
    expect(await sftp.exists(join(dir, 'x'))).toBe(true);
    expect(await sftp.exists(join(dir, 'gone'))).toBe(false);
    await expect(sftp.stat(join(dir, 'gone'))).rejects.toMatchObject({
      response: { code: 'file_not_found' },
    });
  });

  it('makes folders and those above, saying which; never through a file', async () => {
    expect(await sftp.makeFolders(join(dir, 'a', 'b'))).toEqual([
      join(dir, 'a'),
      join(dir, 'a', 'b'),
    ]);
    expect(await sftp.makeFolders(join(dir, 'a', 'b'))).toEqual([]);
    writeFileSync(join(dir, 'f'), '');
    await expect(sftp.makeFolders(join(dir, 'f', 'c'))).rejects.toMatchObject({
      response: { code: 'wrong_type' },
    });
  });

  it('removes a file (one already gone is fine); unlink says it’s gone', async () => {
    writeFileSync(join(dir, 'x'), '');
    await sftp.remove(join(dir, 'x'));
    await sftp.remove(join(dir, 'x'));
    await expect(sftp.unlink(join(dir, 'x'))).rejects.toMatchObject({
      response: { code: 'file_not_found' },
    });
    mkdirSync(join(dir, 'd'));
    await sftp.removeFolder(join(dir, 'd'));
    expect(await sftp.exists(join(dir, 'd'))).toBe(false);
  });
});
