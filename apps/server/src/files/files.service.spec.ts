import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
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
  let files: FilesService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'files-'));
    ask = vi.fn().mockResolvedValue({ ok: true });
    tryRecord = vi.fn().mockResolvedValue(undefined);
    const linuxSessions = {
      sftp: () => ({ sftp: new Sftp(fakeSftp()), username: 'anna' }),
      ask,
    } as unknown as LinuxSessions;
    files = new FilesService(
      linuxSessions,
      {} as SystemReader,
      { tryRecord } as unknown as AuditService,
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

  it('never /', async () => {
    await expect(files.delete('s1', '/', ACTOR)).rejects.toMatchObject({
      response: { code: 'permission_denied' },
    });
  });
});
