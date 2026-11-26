import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { FILES_LIMITS } from '@ilex/shared';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditService } from '../audit/audit.service.js';
import type { SystemReader } from '../host/system-reader.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { Sftp } from '../linux-sessions/sftp.js';
import { fakeSftp } from '../linux-sessions/testing.js';
import { FilesService } from './files.service.js';

const ACTOR = { user: { id: 'u1', username: 'owner' }, ip: '127.0.0.1' } as never;

describe('FilesService.delete', () => {
  let dir: string;
  let ask: ReturnType<typeof vi.fn>;
  let tryRecord: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;
  let files: FilesService;
  /** Whether each SFTP asked for was root's. */
  let sftpAsked: boolean[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'files-'));
    ask = vi.fn().mockResolvedValue({ ok: true });
    tryRecord = vi.fn().mockResolvedValue(undefined);
    record = vi.fn().mockResolvedValue(undefined);
    sftpAsked = [];
    const linuxSessions = {
      sftp: (_id: string, options?: { root?: boolean }) => {
        sftpAsked.push(options?.root === true);
        return { sftp: new Sftp(fakeSftp()), username: 'anna' };
      },
      ask,
    } as unknown as LinuxSessions;
    files = new FilesService(
      linuxSessions,
      {} as SystemReader,
      { tryRecord, record } as unknown as AuditService,
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a folder goes through the helper’s rm as the account — never walked over SFTP', async () => {
    mkdirSync(join(dir, 'share', 'a'), { recursive: true });
    writeFileSync(join(dir, 'share', 'a', 'f'), 'x');
    await files.delete('s1', `${join(dir, 'share')}/`, ACTOR);
    expect(ask).toHaveBeenCalledWith(
      's1',
      { action: 'paths.remove', paths: [join(dir, 'share')], administrator: false },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    // The helper is faked: nothing was deleted here, by SFTP or otherwise.
    expect(existsSync(join(dir, 'share', 'a', 'f'))).toBe(true);
    expect(tryRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'files.delete',
        details: { linuxUser: 'anna', path: join(dir, 'share') },
      }),
    );
  });

  it('as root: root’s SFTP, a folder through ilex-root’s removal (sudo’s), audited as root', async () => {
    mkdirSync(join(dir, 'etc-like'));
    writeFileSync(join(dir, 'root-file'), 'x');
    await files.delete('s1', join(dir, 'etc-like'), ACTOR, true);
    await files.delete('s1', join(dir, 'root-file'), ACTOR, true);
    expect(sftpAsked).toEqual([true, true]);
    expect(ask).toHaveBeenCalledWith(
      's1',
      { action: 'paths.remove', paths: [join(dir, 'etc-like')], administrator: true },
      expect.objectContaining({ sudo: true }),
    );
    expect(tryRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'files.delete',
        details: { linuxUser: 'anna', asRoot: true, path: join(dir, 'root-file') },
      }),
    );
  });

  it('as root, a change is recorded as requested first — without the audit log, nothing changes', async () => {
    writeFileSync(join(dir, 'kept'), 'x');
    await files.delete('s1', join(dir, 'kept'), ACTOR, true).catch(() => undefined);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'files.delete', outcome: 'requested' }),
    );
    writeFileSync(join(dir, 'kept'), 'x');
    record.mockRejectedValue(new Error('database down'));
    const refused = await files
      .delete('s1', join(dir, 'kept'), ACTOR, true)
      .catch((error: unknown) => error);
    expect((refused as { getResponse(): { code: string } }).getResponse().code).toBe(
      'audit_unavailable',
    );
    expect(existsSync(join(dir, 'kept'))).toBe(true);
  });

  it('as the account, no requested entry (as before)', async () => {
    writeFileSync(join(dir, 'mine'), 'x');
    await files.delete('s1', join(dir, 'mine'), ACTOR);
    expect(record).not.toHaveBeenCalled();
  });

  it('sudo locked meanwhile: a folder’s removal says sudo_required', async () => {
    mkdirSync(join(dir, 'f'));
    ask.mockResolvedValue({ ok: false, error: 'sudo_required' });
    const error = await files.delete('s1', join(dir, 'f'), ACTOR, true).catch((e: unknown) => e);
    expect((error as { getResponse(): { code: string } }).getResponse().code).toBe('sudo_required');
  });

  it('a file or a link is unlinked (a link to a folder: the link, never what it points to)', async () => {
    mkdirSync(join(dir, 'kept'));
    writeFileSync(join(dir, 'kept', 'f'), 'x');
    symlinkSync(join(dir, 'kept'), join(dir, 'link'));
    writeFileSync(join(dir, 'file'), 'x');
    await files.delete('s1', join(dir, 'link'), ACTOR);
    await files.delete('s1', join(dir, 'file'), ACTOR);
    expect(ask).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'link'))).toBe(false);
    expect(existsSync(join(dir, 'file'))).toBe(false);
    expect(existsSync(join(dir, 'kept', 'f'))).toBe(true);
  });

  it('what the helper refuses is our error, and nothing is recorded', async () => {
    mkdirSync(join(dir, 'theirs'));
    for (const [error, code] of [
      ['not_permitted', 'permission_denied'],
      ['path_protected', 'permission_denied'],
      ['ended', 'linux_session_required'],
      ['timed_out', 'file_operation_failed'],
    ]) {
      ask.mockResolvedValueOnce({ ok: false, error });
      await expect(files.delete('s1', join(dir, 'theirs'), ACTOR)).rejects.toMatchObject({
        response: { code },
      });
    }
    expect(tryRecord).not.toHaveBeenCalled();
  });

  it('as root, a system folder is never renamed or moved — a file in one is', async () => {
    const etc = join(dir, 'etc');
    mkdirSync(etc);
    writeFileSync(join(etc, 'hosts'), 'x');
    const refused = await files
      .rename('s1', '/etc', '/etc.old', ACTOR, true)
      .catch((error: unknown) => error);
    expect((refused as { getResponse(): { code: string } }).getResponse().code).toBe(
      'permission_denied',
    );
    // A file below /etc (here a temporary one standing in): renamed as root like anywhere else.
    await files.rename('s1', join(etc, 'hosts'), join(etc, 'hosts.old'), ACTOR, true);
    expect(existsSync(join(etc, 'hosts.old'))).toBe(true);
  });

  it('never /', async () => {
    await expect(files.delete('s1', '/', ACTOR)).rejects.toMatchObject({
      response: { code: 'permission_denied' },
    });
  });
});

describe('FilesService.upload', () => {
  let dir: string;
  let files: FilesService;
  let usedRoot: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'files-'));
    usedRoot = vi.fn();
    const linuxSessions = {
      sftp: () => ({ sftp: new Sftp(fakeSftp()), username: 'anna' }),
      usedRoot,
    } as unknown as LinuxSessions;
    files = new FilesService(
      linuxSessions,
      {} as SystemReader,
      {
        tryRecord: vi.fn().mockResolvedValue(undefined),
        record: vi.fn().mockResolvedValue(undefined),
      } as unknown as AuditService,
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const upload = (name: string, content: string, replace = false) =>
    files.upload(
      's1',
      { folder: dir, name, replace },
      Readable.from([Buffer.from(content)]),
      content.length,
      ACTOR,
    );
  const mode = (name: string) => statSync(join(dir, name)).mode & 0o7777;

  it('as root, a long upload keeps sudo unlocked while its bytes flow; as the account, never', async () => {
    const chunks = ['a', 'b', 'c'].map((c) => Buffer.from(c));
    await files.upload(
      's1',
      { folder: dir, name: 'x', replace: false, root: true },
      Readable.from(chunks),
      3,
      ACTOR,
    );
    expect(usedRoot).toHaveBeenCalledTimes(3);
    await upload('y', 'abc');
    expect(usedRoot).toHaveBeenCalledTimes(3);
  });

  it('a new file: 0644 — never the 0666 ssh2 would set past the umask', async () => {
    await upload('compose.yml', 'services: {}\n');
    expect(mode('compose.yml')).toBe(0o644);
    expect(readFileSync(join(dir, 'compose.yml'), 'utf8')).toBe('services: {}\n');
  });

  it('a replaced file keeps its permissions, without setuid or setgid', async () => {
    writeFileSync(join(dir, '.env'), 'old');
    chmodSync(join(dir, '.env'), 0o600);
    await upload('.env', 'SECRET=x', true);
    expect(mode('.env')).toBe(0o600);
    writeFileSync(join(dir, 'tool'), 'old');
    chmodSync(join(dir, 'tool'), 0o4755);
    await upload('tool', 'new', true);
    expect(mode('tool')).toBe(0o755);
  });
});

describe('FilesService previews', () => {
  let dir: string;
  let usedRoot: ReturnType<typeof vi.fn>;
  let files: FilesService;
  let sftpAsked: boolean[];
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  const collect = async (stream: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'files-'));
    usedRoot = vi.fn();
    sftpAsked = [];
    const linuxSessions = {
      sftp: (_id: string, options?: { root?: boolean }) => {
        sftpAsked.push(options?.root === true);
        return { sftp: new Sftp(fakeSftp()), username: 'anna' };
      },
      usedRoot,
    } as unknown as LinuxSessions;
    files = new FilesService(linuxSessions, {} as SystemReader, {} as AuditService);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['a PNG', PNG, 'image/png'],
    ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]), 'image/jpeg'],
    ['a GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1'), 'image/gif'],
    ['a WebP', Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'), 'image/webp'],
  ])('%s is known by its bytes and sent whole', async (_name, head, type) => {
    const content = Buffer.concat([head, Buffer.alloc(200_000, 7)]);
    writeFileSync(join(dir, 'picture.bin'), content);
    const image = await files.previewImage('s1', join(dir, 'picture.bin'));
    expect(image.type).toBe(type);
    expect((await collect(image.stream)).equals(content)).toBe(true);
  });

  it('a .png holding a page is refused, an SVG too (never an image)', async () => {
    writeFileSync(join(dir, 'page.png'), '<html><script>alert(1)</script></html>');
    writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(dir, 'tiny'), Buffer.from([0x89, 0x50]));
    for (const name of ['page.png', 'logo.svg', 'tiny']) {
      await expect(files.previewImage('s1', join(dir, name))).rejects.toMatchObject({
        response: { code: 'not_previewable' },
      });
    }
  });

  it('the response given up before it starts: the file is closed all the same', async () => {
    const source = new PassThrough();
    source.write(PNG);
    vi.spyOn(Sftp.prototype, 'readStream').mockResolvedValue(source);
    writeFileSync(join(dir, 'p.png'), PNG);
    const image = await files.previewImage('s1', join(dir, 'p.png'));
    image.stream.destroy();
    await vi.waitFor(() => expect(source.destroyed).toBe(true));
    vi.restoreAllMocks();
  });

  it('more than 20 MB, a folder or a missing file is refused', async () => {
    const big = join(dir, 'big.png');
    writeFileSync(big, PNG);
    truncateSync(big, FILES_LIMITS.previewImageMaxBytes + 1);
    await expect(files.previewImage('s1', big)).rejects.toMatchObject({
      response: { code: 'file_too_large' },
    });
    await expect(files.previewImage('s1', dir)).rejects.toMatchObject({
      response: { code: 'wrong_type' },
    });
    await expect(files.previewImage('s1', join(dir, 'gone.png'))).rejects.toMatchObject({
      response: { code: 'file_not_found' },
    });
  });

  it('as root: root’s SFTP, and the bytes sent count as use of sudo', async () => {
    writeFileSync(join(dir, 'p.png'), Buffer.concat([PNG, Buffer.alloc(300_000)]));
    const image = await files.previewImage('s1', join(dir, 'p.png'), true);
    await collect(image.stream);
    expect(sftpAsked).toEqual([true]);
    expect(usedRoot).toHaveBeenCalled();
    writeFileSync(join(dir, 'shadow'), 'root:*:19000:0:99999:7:::\n');
    expect((await files.readText('s1', join(dir, 'shadow'), true)).text).toContain('root:*');
    expect(sftpAsked).toEqual([true, true]);
  });

  it('text: the whole file when small, its size', async () => {
    writeFileSync(join(dir, 'app.env'), 'PORT=8080\nNAME=Grüße\n');
    expect(await files.readText('s1', join(dir, 'app.env'))).toEqual({
      text: 'PORT=8080\nNAME=Grüße\n',
      truncated: false,
      size: Buffer.byteLength('PORT=8080\nNAME=Grüße\n'),
    });
  });

  it('text: only the first 256 KB, a character cut at the end left out', async () => {
    const max = FILES_LIMITS.previewTextMaxBytes;
    // "ü" is two bytes: the second falls just past the limit.
    writeFileSync(join(dir, 'long.log'), `${'a'.repeat(max - 1)}ü${'b'.repeat(1000)}`);
    const answer = await files.readText('s1', join(dir, 'long.log'));
    expect(answer.truncated).toBe(true);
    expect(answer.text).toBe('a'.repeat(max - 1));
    expect(answer.size).toBe(max + 1 + 1000);
  });

  it('text: invalid UTF-8 becomes U+FFFD; a NUL byte early means binary', async () => {
    writeFileSync(join(dir, 'latin1.txt'), Buffer.from([0x61, 0xe9, 0x62]));
    expect((await files.readText('s1', join(dir, 'latin1.txt'))).text).toBe('a�b');
    writeFileSync(join(dir, 'program'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]));
    await expect(files.readText('s1', join(dir, 'program'))).rejects.toMatchObject({
      response: { code: 'not_text' },
    });
    await expect(files.readText('s1', dir)).rejects.toMatchObject({
      response: { code: 'wrong_type' },
    });
  });
});
