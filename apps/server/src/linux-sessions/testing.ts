import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import type { SFTPWrapper } from 'ssh2';

/** ssh2's SFTP calls, done on this machine's files (errors as SFTP's status codes). */
export function fakeSftp(): SFTPWrapper {
  const sftpError = (error: NodeJS.ErrnoException) =>
    // OpenSSH says "no such file" for ENOTDIR too.
    Object.assign(error, { code: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 2 : 3 });
  const done =
    <T>(cb: (error: Error | null, value?: T) => void) =>
    (error: NodeJS.ErrnoException | null, value?: T) =>
      cb(error ? sftpError(error) : null, value);
  return {
    stat: (path: string, cb: never) => fs.stat(path, done(cb)),
    lstat: (path: string, cb: never) => fs.lstat(path, done(cb)),
    readdir: (path: string, cb: (e: Error | null, list?: unknown) => void) =>
      fs.readdir(path, (error, names) =>
        done(cb)(
          error,
          names?.map((filename) => ({ filename, attrs: {} })),
        ),
      ),
    createReadStream: (path: string, options: { start: number; end: number }) => {
      const out = new PassThrough();
      fs.createReadStream(path, options)
        .on('error', (error: NodeJS.ErrnoException) => out.destroy(sftpError(error)))
        .pipe(out);
      return out;
    },
    // Like ssh2's: the mode set after opening, so no umask applies.
    createWriteStream: (path: string, options?: { mode?: number }) => {
      const mode = options?.mode ?? 0o666;
      const out = fs.createWriteStream(path, { mode });
      out.on('open', () => fs.chmodSync(path, mode));
      return out;
    },
    writeFile: (path: string, data: string, options: { mode: number }, cb: never) =>
      fs.writeFile(path, data, { mode: options.mode }, done(cb)),
    chmod: (path: string, mode: number, cb: never) => fs.chmod(path, mode, done(cb)),
    ext_openssh_rename: (from: string, to: string, cb: never) => fs.rename(from, to, done(cb)),
    rename: (from: string, to: string, cb: never) => fs.rename(from, to, done(cb)),
    unlink: (path: string, cb: never) => fs.unlink(path, done(cb)),
    rmdir: (path: string, cb: never) => fs.rmdir(path, done(cb)),
    // With options or without (then the callback comes second).
    mkdir: (path: string, ...args: unknown[]) => {
      const cb = args.pop() as never;
      const options = args[0] as { mode: number } | undefined;
      fs.mkdir(path, options ?? {}, done(cb));
    },
  } as unknown as SFTPWrapper;
}
