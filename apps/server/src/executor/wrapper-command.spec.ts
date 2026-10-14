import {
  backupWrapperCommand,
  INSTALLED_BACKUP_WRAPPER,
  INSTALLED_WRAPPER,
  wrapperCommand,
} from './wrapper-command.js';

describe('wrapperCommand', () => {
  it('runs the installed wrapper through sudo -n, with a fixed small environment', () => {
    expect(wrapperCommand('sudo', 'up', 'immich')).toEqual({
      file: '/usr/bin/sudo',
      args: ['-n', INSTALLED_WRAPPER, 'up', 'immich'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
    });
    expect(INSTALLED_WRAPPER).toBe('/opt/homelab/libexec/homelab-compose.mts');
  });

  it('runs the repository’s wrapper with Node in direct mode, naming its config file', () => {
    expect(
      wrapperCommand('direct', 'down', 'navidrome', {
        wrapper: '/repo/w.mts',
        configFile: '/c.json',
      }),
    ).toEqual({
      file: process.execPath,
      args: ['/repo/w.mts', 'down', 'navidrome'],
      env: {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C.UTF-8',
        HOMELAB_WRAPPER_CONFIG: '/c.json',
      },
    });
  });

  it('never passes the app’s own environment on', () => {
    process.env['DATABASE_URL_PROBE'] = 'postgresql://secret';
    try {
      for (const mode of ['sudo', 'direct'] as const) {
        expect(Object.values(wrapperCommand(mode, 'up', 'x').env).join()).not.toContain('secret');
      }
    } finally {
      delete process.env['DATABASE_URL_PROBE'];
    }
  });

  it('runs the backup wrapper the same way: through sudo -n, its action the only argument', () => {
    expect(backupWrapperCommand('sudo', 'run')).toEqual({
      file: '/usr/bin/sudo',
      args: ['-n', INSTALLED_BACKUP_WRAPPER, 'run'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
    });
    expect(INSTALLED_BACKUP_WRAPPER).toBe('/opt/homelab/libexec/homelab-backup.mts');
    expect(
      backupWrapperCommand('direct', 'passphrase', {
        wrapper: '/repo/b.mts',
        configFile: '/c.json',
      }),
    ).toEqual({
      file: process.execPath,
      args: ['/repo/b.mts', 'passphrase'],
      env: {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C.UTF-8',
        HOMELAB_WRAPPER_CONFIG: '/c.json',
      },
    });
  });
});
