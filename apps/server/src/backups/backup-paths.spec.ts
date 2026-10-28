import type { ProgramConfig } from '../root-programs/root-programs.model.js';
import {
  archiveTime,
  destinationRoots,
  isAllowedFolder,
  overlaps,
  skipInside,
  stateDir,
} from './backup-paths.js';

const config = {
  protectedPaths: ['/opt/laris', '/etc/laris', '/var/lib/laris'],
} as ProgramConfig;

describe('backup paths', () => {
  it('allows any folder but the system’s and the platform’s', () => {
    for (const path of [
      '/srv/laris/docs',
      '/home/alice',
      '/home/alice/Photos',
      '/data',
      '/mnt/usb/x',
    ]) {
      expect(isAllowedFolder(config, path), path).toBe(true);
    }
  });

  it('refuses system and platform folders, what holds them, and tricks', () => {
    for (const path of [
      '/',
      '/etc',
      '/root/x',
      '/var/lib/laris',
      '/var/lib/docker/volumes',
      '/opt',
      '/srv/../etc',
      'srv/laris/docs',
      '/srv/laris/docs/',
    ]) {
      expect(isAllowedFolder(config, path), path).toBe(false);
    }
  });

  it('a skip is inside one of the folders; overlap goes both ways', () => {
    expect(skipInside('/a/b/cache', ['/a/b'])).toBe(true);
    expect(skipInside('/a/bc', ['/a/b'])).toBe(false);
    expect(overlaps('/a', '/a/b')).toBe(true);
    expect(overlaps('/a/b', '/a')).toBe(true);
    expect(overlaps('/a/b', '/a/c')).toBe(false);
  });

  it('any disk in production; the pretend ones in development', () => {
    expect(destinationRoots(config)).toBeNull();
    const dev = {
      ...config,
      backup: { dev: { dir: '/d', destinationRoots: ['/d/mnt'], mountInfo: '/d/m' } },
    };
    expect(destinationRoots(dev as ProgramConfig)).toEqual(['/d/mnt']);
    expect(stateDir(dev as ProgramConfig)).toBe('/d/state');
    expect(stateDir(config)).toBe('/var/lib/laris/backups');
  });

  it('reads an archive’s time from its name', () => {
    expect(archiveTime('0b6f3c1e-2d4a-4f8b-9c3e-1a2b3c4d5e6f-2026-10-14T03:00:12')).toBe(
      '2026-10-14T03:00:12.000Z',
    );
  });
});
