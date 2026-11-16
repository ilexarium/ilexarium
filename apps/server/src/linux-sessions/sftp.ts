import { FILES_ERROR_CODES } from '@ilex/shared';
import { posix } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { SFTPWrapper, Stats } from 'ssh2';
import { filesCode, toFilesError } from '../files/files-errors.js';
import { linuxError } from './linux-session-errors.js';

/** One SFTP call as a promise; its errors as the Files codes (not found, permission denied, …). */
export function call<T>(
  run: (done: (error: Error | null | undefined, value?: T) => void) => void,
): Promise<T> {
  return new Promise((ok, fail) =>
    run((error, value) => (error ? fail(toFilesError(error)) : ok(value as T))),
  );
}

const missing = (error: unknown) => filesCode(error) === FILES_ERROR_CODES.notFound;
const orNull = (error: unknown) => {
  if (missing(error)) return null;
  throw error;
};

/** The signed-in account's files over its SFTP channel: whatever Linux lets it do. */
export class Sftp {
  constructor(private readonly sftp: SFTPWrapper) {}

  stat(path: string): Promise<Stats> {
    return call<Stats>((done) => this.sftp.stat(path, done));
  }

  lstat(path: string): Promise<Stats> {
    return call<Stats>((done) => this.sftp.lstat(path, done));
  }

  /** Its stat (links followed); null when it doesn't exist. */
  statOrNull(path: string): Promise<Stats | null> {
    return this.stat(path).catch(orNull);
  }

  /** Whether something is there (a link itself counts). */
  exists(path: string): Promise<boolean> {
    return this.lstat(path).then(
      () => true,
      (error: unknown) => orNull(error) ?? false,
    );
  }

  entries(path: string): Promise<{ filename: string; attrs: Stats }[]> {
    return call((done) => this.sftp.readdir(path, done));
  }

  /** The names in a folder; empty when it doesn't exist. */
  list(path: string): Promise<string[]> {
    return this.entries(path).then(
      (entries) => entries.map((entry) => entry.filename),
      (error: unknown) => orNull(error) ?? [],
    );
  }

  /** At most `max` bytes of a file from byte `start`; null when it doesn't exist. */
  async read(path: string, max: number, start = 0): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of this.sftp.createReadStream(path, {
        start,
        end: start + max - 1,
      }) as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
    } catch (error) {
      return orNull(toFilesError(error));
    }
    return Buffer.concat(chunks);
  }

  /** A text file read whole, refused past `max` bytes; null when it doesn't exist. */
  async readText(path: string, max: number): Promise<string | null> {
    const content = await this.read(path, max + 1);
    if (content === null) return null;
    if (content.length > max) throw linuxError(FILES_ERROR_CODES.tooLarge, `${path} is too large`);
    return content.toString('utf8');
  }

  /** Opened before anything is sent, so a file Linux won't let this account read is a clear 403. */
  async readStream(path: string): Promise<Readable> {
    const handle = await call<Buffer>((done) => this.sftp.open(path, 'r', done));
    return this.sftp.createReadStream(path, { handle, autoClose: true });
  }

  /**
   * A new file, written as it streams. `mode` is set as it is: ssh2 sets it after opening (no
   * umask), and its own default would be 0666 — anyone could change the file.
   */
  writeStream(path: string, mode: number): Writable {
    return this.sftp.createWriteStream(path, { mode }) as unknown as Writable;
  }

  /** Written whole: to a new file beside it, then renamed over it (a crash never leaves half). */
  async writeText(path: string, text: string, mode: number): Promise<void> {
    const temporary = posix.join(
      posix.dirname(path),
      `.${posix.basename(path)}.ilex-${process.pid}`,
    );
    await call<void>((done) =>
      this.sftp.writeFile(temporary, text, { mode, flag: 'w' }, (error) => done(error)),
    );
    await call<void>((done) => this.sftp.chmod(temporary, mode, done));
    try {
      await this.rename(temporary, path, true);
    } catch {
      // A server without posix-rename: the old file goes first.
      await this.remove(path).catch(() => undefined);
      await this.rename(temporary, path, false);
    }
  }

  /** `replace`: over what's there, in one step (OpenSSH's posix-rename); else never over it. */
  rename(from: string, to: string, replace: boolean): Promise<void> {
    return call<void>((done) =>
      replace ? this.sftp.ext_openssh_rename(from, to, done) : this.sftp.rename(from, to, done),
    );
  }

  unlink(path: string): Promise<void> {
    return call<void>((done) => this.sftp.unlink(path, done));
  }

  /** A file deleted; one already gone is fine. */
  remove(path: string): Promise<void> {
    return this.unlink(path).catch((error: unknown) => void orNull(error));
  }

  /** Without a mode: the SSH server's default (its umask). */
  makeFolder(path: string, mode?: number): Promise<void> {
    return call<void>((done) =>
      mode === undefined ? this.sftp.mkdir(path, done) : this.sftp.mkdir(path, { mode }, done),
    );
  }

  removeFolder(path: string): Promise<void> {
    return call<void>((done) => this.sftp.rmdir(path, done));
  }

  /** Creates a folder and those above it; returns the ones it created, top first. */
  async makeFolders(path: string, mode = 0o755): Promise<string[]> {
    const created: string[] = [];
    const missingOnes: string[] = [];
    for (let current = path; current !== '/'; current = posix.dirname(current)) {
      const stat = await this.statOrNull(current);
      if (stat) {
        if (!stat.isDirectory()) {
          throw linuxError(FILES_ERROR_CODES.wrongType, `${current} is not a folder`);
        }
        break;
      }
      missingOnes.unshift(current);
    }
    for (const folder of missingOnes) {
      await this.makeFolder(folder, mode);
      created.push(folder);
    }
    return created;
  }
}
