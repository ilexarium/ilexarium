import { FILES_ERROR_CODES } from '@laris/shared';
import { posix } from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import { filesCode, toFilesError } from '../files/files-errors.js';
import { linuxError } from '../linux-sessions/linux-session-errors.js';

/** One SFTP call as a promise; its errors as the Files codes (not found, permission denied, …). */
function call<T>(
  run: (done: (error: Error | null | undefined, value?: T) => void) => void,
): Promise<T> {
  return new Promise((ok, fail) =>
    run((error, value) => (error ? fail(toFilesError(error)) : ok(value as T))),
  );
}

const missing = (error: unknown) => filesCode(error) === FILES_ERROR_CODES.notFound;

/** An app's files, read and written as the signed-in account over its SFTP channel. */
export class AppSftp {
  constructor(private readonly sftp: SFTPWrapper) {}

  stat(path: string): Promise<Stats | null> {
    return call<Stats>((done) => this.sftp.stat(path, done)).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
  }

  async isFolder(path: string): Promise<boolean> {
    return (await this.stat(path))?.isDirectory() ?? false;
  }

  /** The names in a folder; empty when it doesn't exist. */
  list(path: string): Promise<string[]> {
    return call<{ filename: string }[]>((done) => this.sftp.readdir(path, done)).then(
      (entries) => entries.map((entry) => entry.filename),
      (error: unknown) => {
        if (missing(error)) return [];
        throw error;
      },
    );
  }

  /** A file's text, at most `max` bytes from `from`; null when it doesn't exist. */
  async read(path: string, max: number, from = 0): Promise<Buffer | null> {
    let handle: Buffer;
    try {
      handle = await call<Buffer>((done) => this.sftp.open(path, 'r', done));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      const chunks: Buffer[] = [];
      let position = from;
      let total = 0;
      while (total < max) {
        const buffer = Buffer.alloc(Math.min(32 * 1024, max - total));
        const read = await new Promise<number>((ok, fail) =>
          this.sftp.read(handle, buffer, 0, buffer.length, position, (error, bytes) =>
            // ssh2 reports the end of the file as an error with code 1 (EOF).
            error && (error as { code?: unknown }).code !== 1
              ? fail(toFilesError(error))
              : ok(bytes ?? 0),
          ),
        );
        if (read <= 0) break;
        chunks.push(buffer.subarray(0, read));
        position += read;
        total += read;
      }
      return Buffer.concat(chunks);
    } finally {
      this.sftp.close(handle, () => undefined);
    }
  }

  /** A text file read whole, refused past `max` bytes; null when it doesn't exist. */
  async readText(path: string, max: number): Promise<string | null> {
    const content = await this.read(path, max + 1);
    if (content === null) return null;
    if (content.length > max) throw linuxError(FILES_ERROR_CODES.tooLarge, `${path} is too large`);
    return content.toString('utf8');
  }

  /** Written whole: to a new file beside it, then renamed over it (a crash never leaves half). */
  async writeText(path: string, text: string, mode: number): Promise<void> {
    const temporary = posix.join(
      posix.dirname(path),
      `.${posix.basename(path)}.laris-${process.pid}`,
    );
    await call<void>((done) =>
      this.sftp.writeFile(temporary, text, { mode, flag: 'w' }, (error) => done(error)),
    );
    await call<void>((done) => this.sftp.chmod(temporary, mode, done));
    try {
      await call<void>((done) => this.sftp.ext_openssh_rename(temporary, path, done));
    } catch {
      // A server without posix-rename: the old file goes first.
      await call<void>((done) => this.sftp.unlink(path, done)).catch(() => undefined);
      await call<void>((done) => this.sftp.rename(temporary, path, done));
    }
  }

  rename(from: string, to: string): Promise<void> {
    return call<void>((done) => this.sftp.rename(from, to, done));
  }

  remove(path: string): Promise<void> {
    return call<void>((done) => this.sftp.unlink(path, done)).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }

  removeFolder(path: string): Promise<void> {
    return call<void>((done) => this.sftp.rmdir(path, done));
  }

  /** Creates a folder and those above it; returns the ones it created, top first. */
  async makeFolders(path: string, mode = 0o755): Promise<string[]> {
    const created: string[] = [];
    const missingOnes: string[] = [];
    for (let current = path; current !== '/'; current = posix.dirname(current)) {
      const stat = await this.stat(current);
      if (stat) {
        if (!stat.isDirectory()) {
          throw linuxError(FILES_ERROR_CODES.wrongType, `${current} is not a folder`);
        }
        break;
      }
      missingOnes.unshift(current);
    }
    for (const folder of missingOnes) {
      await call<void>((done) => this.sftp.mkdir(folder, { mode }, done));
      created.push(folder);
    }
    return created;
  }
}
