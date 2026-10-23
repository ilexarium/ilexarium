import type { WrapperConfig } from '../executor/executor.model.js';
import {
  archiveTime,
  destinationRoots,
  isAllowedFolder,
  isAllowedServiceFolder,
  isDestinationPath,
  stateDir,
} from './backup-paths.js';

const config = {
  storageRoots: ['/srv/laris'],
  protectedPaths: ['/opt/laris', '/etc/laris', '/var/lib/laris'],
} as WrapperConfig;

describe('backup paths', () => {
  it('allows folders in the storage roots and home folders', () => {
    for (const path of ['/srv/laris/docs', '/home/alice', '/home/alice/Photos']) {
      expect(isAllowedFolder(config, path), path).toBe(true);
    }
  });

  it('refuses system and platform folders, all of /home, and tricks', () => {
    for (const path of [
      '/',
      '/etc',
      '/root/x',
      '/home',
      '/var/lib/laris',
      '/srv',
      // All of it would take in the restore area (a restored master key, a database dump) —
      // as the wrapper refuses it.
      '/srv/laris',
      '/srv/laris/restores/2026-10-23',
      '/srv/laris/../../etc',
      'srv/laris/docs',
      '/srv/laris/docs/',
    ]) {
      expect(isAllowedFolder(config, path), path).toBe(false);
    }
  });

  it('allows service folders only in the storage roots', () => {
    expect(isAllowedServiceFolder(config, '/srv/laris/immich/library')).toBe(true);
    expect(isAllowedServiceFolder(config, '/home/alice')).toBe(false);
  });

  it('takes disks below /mnt and /media (development: its pretend ones)', () => {
    expect(destinationRoots(config)).toEqual(['/mnt', '/media']);
    expect(isDestinationPath(config, '/mnt/usb')).toBe(true);
    expect(isDestinationPath(config, '/mnt')).toBe(false);
    expect(isDestinationPath(config, '/srv/laris')).toBe(false);
    const dev = {
      ...config,
      backup: { dev: { dir: '/d', destinationRoots: ['/d/mnt'], mountInfo: '/d/m' } },
    };
    expect(isDestinationPath(dev as WrapperConfig, '/d/mnt/usb')).toBe(true);
    expect(stateDir(dev as WrapperConfig)).toBe('/d/state');
    expect(stateDir(config)).toBe('/var/lib/laris/backups');
  });

  it('reads an archive’s time from its name', () => {
    expect(archiveTime('0b6f3c1e-2d4a-4f8b-9c3e-1a2b3c4d5e6f-2026-10-14T03:00:12')).toBe(
      '2026-10-14T03:00:12.000Z',
    );
  });
});
