import { Injectable } from '@nestjs/common';
import {
  type FileEntry,
  FILES_ERROR_CODES,
  FILES_LIMITS,
  type FileList,
  type FileSummary,
  type FileType,
} from '@ilex/shared';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AuditService } from '../audit/audit.service.js';
import { SystemReader } from '../host/system-reader.js';
import { linuxError } from '../linux-sessions/linux-session-errors.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { LinuxActor } from '../linux-sessions/linux-sessions.model.js';
import { removalError, toFilesError } from './files-errors.js';
import { DELETE_TIMEOUT_MS, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from './files.constants.js';
import type { Download } from './files.model.js';

function typeOf(mode: number): FileType {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'folder';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'link';
    default:
      return 'other';
  }
}

/** `rwxr-x---` (with s/t for setuid, setgid and sticky, like `ls -l`). */
export function permissions(mode: number): string {
  const bit = (mask: number, char: string) => (mode & mask ? char : '-');
  const special = (exec: number, flag: number, set: string, unset: string) =>
    mode & flag ? (mode & exec ? set : unset) : bit(exec, 'x');
  return (
    bit(0o400, 'r') +
    bit(0o200, 'w') +
    special(0o100, 0o4000, 's', 'S') +
    bit(0o040, 'r') +
    bit(0o020, 'w') +
    special(0o010, 0o2000, 's', 'S') +
    bit(0o004, 'r') +
    bit(0o002, 'w') +
    special(0o001, 0o1000, 't', 'T')
  );
}

/**
 * The file explorer over the Linux session's SFTP channel:
 * whatever the signed-in Linux account may do, nothing more — Linux decides, the app adds no
 * limits of its own. Uploads and downloads stream (never held in memory); uploads go to a
 * temporary name beside the target first, renamed when complete. Uploads, renames and deletes
 * are audited (Linux user and path, never content).
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly linuxSessions: LinuxSessions,
    private readonly systemReader: SystemReader,
    private readonly auditService: AuditService,
  ) {}

  /** A folder's contents, folders (and links to them) first, then by name. */
  async list(appSessionId: string, path: string): Promise<FileList> {
    const { sftp } = this.linuxSessions.sftp(appSessionId);
    const folder = posix.normalize(path);
    const target = await sftp.stat(folder);
    if (typeOf(target.mode) !== 'folder') {
      throw linuxError(FILES_ERROR_CODES.wrongType, 'Not a folder');
    }
    const [raw, users] = await Promise.all([sftp.entries(folder), this.systemReader.users()]);
    const entries = await Promise.all(
      raw.map(async ({ filename, attrs }): Promise<FileEntry> => {
        const type = typeOf(attrs.mode);
        let linkTarget: FileEntry['linkTarget'] = null;
        if (type === 'link') {
          const followed = await sftp.stat(posix.join(folder, filename)).catch(() => null);
          const followedType = followed ? typeOf(followed.mode) : null;
          linkTarget = followedType === 'folder' || followedType === 'file' ? followedType : null;
        }
        return {
          name: filename,
          type,
          linkTarget,
          size: attrs.size,
          modifiedAt: new Date(attrs.mtime * 1000).toISOString(),
          owner: users.get(attrs.uid) ?? String(attrs.uid),
          permissions: permissions(attrs.mode),
        };
      }),
    );
    const isFolder = (e: FileEntry) => e.type === 'folder' || e.linkTarget === 'folder';
    entries.sort(
      (a, b) => Number(isFolder(b)) - Number(isFolder(a)) || a.name.localeCompare(b.name),
    );
    return { path: folder, parent: folder === '/' ? null : posix.dirname(folder), entries };
  }

  /** What deleting `path` would remove; counting stops at 10,000 entries. */
  async summary(appSessionId: string, path: string): Promise<FileSummary> {
    const { sftp } = this.linuxSessions.sftp(appSessionId);
    const target = posix.normalize(path);
    const own = await sftp.lstat(target);
    const type = typeOf(own.mode);
    const result: FileSummary = { type, files: 0, folders: 0, bytes: 0, truncated: false };
    if (type !== 'folder') {
      result.files = 1;
      result.bytes = own.size;
      return result;
    }
    const walk = async (folder: string): Promise<void> => {
      for (const { filename, attrs } of await sftp.entries(folder)) {
        if (result.files + result.folders >= FILES_LIMITS.summaryMaxEntries) {
          result.truncated = true;
          return;
        }
        if (typeOf(attrs.mode) === 'folder') {
          result.folders++;
          await walk(posix.join(folder, filename));
        } else {
          result.files++;
          result.bytes += attrs.size;
        }
      }
    };
    await walk(target);
    return result;
  }

  /**
   * A regular file's contents, as a stream (links followed, like any program would). Opened
   * before anything is sent, so a file Linux won't let this account read is a clear 403.
   */
  async download(appSessionId: string, path: string): Promise<Download> {
    const { sftp } = this.linuxSessions.sftp(appSessionId);
    const target = posix.normalize(path);
    const info = await sftp.stat(target);
    if (typeOf(info.mode) !== 'file') {
      throw linuxError(FILES_ERROR_CODES.wrongType, 'Only files can be downloaded');
    }
    return {
      name: posix.basename(target),
      size: info.size,
      stream: await sftp.readStream(target),
    };
  }

  /**
   * Writes an upload into `folder/name`: to a temporary name beside it first (a broken upload
   * never leaves half a file under the real name), renamed when complete. `size` is the
   * announced length; more than 10 GB, or more bytes than announced, is refused.
   */
  async upload(
    appSessionId: string,
    target: { folder: string; name: string; replace: boolean },
    body: Readable,
    size: number | null,
    actor: LinuxActor,
  ): Promise<void> {
    const { sftp, username } = this.linuxSessions.sftp(appSessionId);
    if (size !== null && size > FILES_LIMITS.uploadMaxBytes) {
      throw linuxError(FILES_ERROR_CODES.tooLarge, 'Larger than 10 GB');
    }
    const folder = posix.normalize(target.folder);
    if (typeOf((await sftp.stat(folder)).mode) !== 'folder') {
      throw linuxError(FILES_ERROR_CODES.wrongType, 'Not a folder');
    }
    const path = posix.join(folder, target.name);
    const existing = await sftp.exists(path);
    if (existing && !target.replace) {
      throw linuxError(FILES_ERROR_CODES.exists, 'A file of that name is there');
    }
    const temporary = posix.join(
      folder,
      `.${target.name}.ilex-upload-${randomBytes(6).toString('hex')}`,
    );
    let written = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        written += chunk.length;
        if (written > FILES_LIMITS.uploadMaxBytes || (size !== null && written > size)) {
          next(linuxError(FILES_ERROR_CODES.tooLarge, 'Larger than announced or than 10 GB'));
        } else next(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, sftp.writeStream(temporary));
      if (size !== null && written !== size) {
        throw linuxError(FILES_ERROR_CODES.failed, 'The upload ended early');
      }
      // Replacing: one atomic step (OpenSSH's posix-rename) — the old file stays until the new
      // one takes its place, so a failure here loses neither.
      await sftp.rename(temporary, path, existing);
    } catch (error) {
      await sftp.remove(temporary).catch(() => undefined);
      throw toFilesError(error);
    }
    await this.record('files.upload', actor, username, {
      path,
      bytes: written,
      replaced: existing,
    });
  }

  async newFolder(appSessionId: string, parent: string, name: string): Promise<void> {
    const { sftp } = this.linuxSessions.sftp(appSessionId);
    const path = posix.join(posix.normalize(parent), name);
    if (await sftp.exists(path)) {
      throw linuxError(FILES_ERROR_CODES.exists, 'Something of that name is there');
    }
    await sftp.makeFolder(path);
  }

  /** Renames or moves — never onto something that exists. */
  async rename(appSessionId: string, from: string, to: string, actor: LinuxActor): Promise<void> {
    const { sftp, username } = this.linuxSessions.sftp(appSessionId);
    const source = posix.normalize(from);
    const destination = posix.normalize(to);
    if (await sftp.exists(destination)) {
      throw linuxError(FILES_ERROR_CODES.exists, 'Something of that name is there');
    }
    await sftp.rename(source, destination, false);
    await this.record('files.rename', actor, username, { from: source, to: destination });
  }

  /**
   * Deletes a file, a link (never what it points to) or a folder with everything in it. A folder
   * goes through the helper (`rm -r --one-file-system` as the account): a walk over SFTP would
   * enter a subfolder by a type read earlier, so someone who swapped it for a link meanwhile
   * would have another folder emptied. What Linux refuses stays; what's deleted stays deleted.
   */
  async delete(appSessionId: string, path: string, actor: LinuxActor): Promise<void> {
    const { sftp, username } = this.linuxSessions.sftp(appSessionId);
    const target = posix.normalize(path).replace(/(.)\/+$/, '$1');
    if (target === '/') throw linuxError(FILES_ERROR_CODES.permissionDenied, 'Not /');
    if (typeOf((await sftp.lstat(target)).mode) === 'folder') {
      const answer = await this.linuxSessions.ask(
        appSessionId,
        { action: 'paths.remove', paths: [target], administrator: false },
        { timeoutMs: DELETE_TIMEOUT_MS },
      );
      if (!answer.ok) throw removalError(answer.error);
    } else {
      await sftp.unlink(target);
    }
    await this.record('files.delete', actor, username, { path: target });
  }

  private record(
    action: 'files.upload' | 'files.rename' | 'files.delete',
    actor: LinuxActor,
    linuxUser: string,
    details: Record<string, string | number | boolean>,
  ): Promise<void> {
    return this.auditService.tryRecord({
      action,
      outcome: 'success',
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { linuxUser, ...details },
    });
  }
}
