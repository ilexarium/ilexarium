import { WRAPPER_FILES } from './wrapper-command.constants.js';
import { wrapperCommand } from './wrapper-command.js';

describe('wrapperCommand', () => {
  it('runs the installed wrapper through sudo -n, with a fixed small environment', () => {
    expect(wrapperCommand('sudo', 'compose', ['up', 'immich'])).toEqual({
      file: '/usr/bin/sudo',
      args: ['-n', '/opt/laris/libexec/laris-compose.mts', 'up', 'immich'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
    });
  });

  it('names exactly the paths the sudoers rule and the installer use', () => {
    expect(Object.values(WRAPPER_FILES).map((file) => file.installed)).toEqual([
      '/opt/laris/libexec/laris-compose.mts',
      '/opt/laris/libexec/laris-backup.mts',
      '/opt/laris/libexec/laris-disk.mts',
      '/opt/laris/libexec/laris-process.mts',
    ]);
  });

  it('runs the repository’s wrapper with Node in direct mode, naming its config file', () => {
    expect(wrapperCommand('direct', 'compose', ['down', 'navidrome'], '/c.json')).toEqual({
      file: process.execPath,
      args: [WRAPPER_FILES.compose.repo, 'down', 'navidrome'],
      env: {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C.UTF-8',
        LARIS_WRAPPER_CONFIG: '/c.json',
      },
    });
    expect(WRAPPER_FILES.compose.repo).toMatch(/system\/wrappers\/laris-compose\.mts$/);
  });

  it('never passes the app’s own environment on', () => {
    process.env['DATABASE_URL_PROBE'] = 'postgresql://secret';
    try {
      for (const mode of ['sudo', 'direct'] as const) {
        expect(
          Object.values(wrapperCommand(mode, 'compose', ['up', 'x']).env).join(),
        ).not.toContain('secret');
      }
    } finally {
      delete process.env['DATABASE_URL_PROBE'];
    }
  });

  it('runs the other wrappers the same way: through sudo -n, their arguments after the path', () => {
    expect(wrapperCommand('sudo', 'backup', ['start'])).toEqual({
      file: '/usr/bin/sudo',
      args: ['-n', '/opt/laris/libexec/laris-backup.mts', 'start'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
    });
    expect(wrapperCommand('direct', 'backup', ['passphrase'], '/c.json')).toEqual({
      file: process.execPath,
      args: [WRAPPER_FILES.backup.repo, 'passphrase'],
      env: {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C.UTF-8',
        LARIS_WRAPPER_CONFIG: '/c.json',
      },
    });
  });
});
