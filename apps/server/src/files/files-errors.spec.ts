import { HttpException } from '@nestjs/common';
import { filesCode, toFilesError } from './files-errors.js';
import { permissions } from './files.service.js';

describe('toFilesError', () => {
  it.each([
    [2, 404, 'file_not_found'],
    [3, 403, 'permission_denied'],
    [4, 409, 'file_operation_failed'],
    [6, 503, 'ssh_unavailable'],
    [7, 503, 'ssh_unavailable'],
    ['ECONNRESET', 503, 'ssh_unavailable'],
  ])('SFTP code %s → %i %s', (code, status, expected) => {
    const error = toFilesError(Object.assign(new Error('x'), { code }));
    expect(error.getStatus()).toBe(status);
    expect(filesCode(error)).toBe(expected);
  });

  it('never passes the server’s own text on', () => {
    const error = toFilesError(Object.assign(new Error('/secret/path: disk full'), { code: 4 }));
    expect(JSON.stringify(error.getResponse())).not.toContain('secret');
  });

  it('passes our own errors through', () => {
    const ours = new HttpException({ message: 'x', code: 'file_exists' }, 409);
    expect(toFilesError(ours)).toBe(ours);
    expect(filesCode(new Error('x'))).toBeUndefined();
  });
});

describe('permissions', () => {
  it.each([
    [0o100644, 'rw-r--r--'],
    [0o040755, 'rwxr-xr-x'],
    [0o040700, 'rwx------'],
    [0o104755, 'rwsr-xr-x'],
    [0o102750, 'rwxr-s---'],
    [0o041777, 'rwxrwxrwt'],
    [0o101644, 'rw-r--r-T'],
  ])('%o is %s', (mode, expected) => {
    expect(permissions(mode)).toBe(expected);
  });
});
