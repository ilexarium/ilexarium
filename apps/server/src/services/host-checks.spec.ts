import type { WrapperConfig } from '../executor/executor.model.js';
import { checkFolder, checkPort, localFolder } from './host-checks.js';

const config: WrapperConfig = {
  catalogDir: '/opt/laris/catalog',
  storageRoots: ['/srv/laris', '/mnt/disk'],
  serviceRoot: '/srv/laris',
  reservedPorts: [22, 3000],
  protectedPaths: ['/srv/laris/.platform'],
  dockerBin: '/usr/bin/docker',
};

describe('checkPort', () => {
  it('refuses reserved and taken ports', () => {
    expect(checkPort(3000, config, new Set())).toBe('port_reserved');
    expect(checkPort(8080, config, new Set([8080]))).toBe('port_in_use');
    expect(checkPort(8080, config, new Set())).toBeNull();
  });
});

describe('checkFolder', () => {
  it.each([
    ['/etc', 'folder', 'path_not_allowed'],
    ['/', 'folder', 'path_not_allowed'],
    ['/var', 'folder', 'path_not_allowed'],
    ['/home/alice', 'folder', 'path_not_allowed'],
    ['/srv/laris/.platform/keys', 'folder', 'path_not_allowed'],
    ['/mnt/disk/music', 'folder', null],
    ['/mnt/disk/music', 'missing', 'path_not_found'],
    ['/mnt/disk/music', 'other', 'path_not_found'],
    // Not readable by the app: the wrapper (root) decides.
    ['/mnt/disk/private', 'unreadable', null],
    // The service's own area: created on deploy.
    ['/srv/laris/demo/data', 'missing', null],
    ['/srv/laris/demo', 'missing', 'path_not_found'],
  ] as const)('%s (%s) → %s', (path, state, expected) => {
    expect(checkFolder(path, 'demo', config, state)).toBe(expected);
  });
});

describe('localFolder', () => {
  it('moves a /srv/laris default to this machine’s service root', () => {
    expect(localFolder('/srv/laris/demo/data', { ...config, serviceRoot: '/data/srv' })).toBe(
      '/data/srv/demo/data',
    );
    expect(localFolder('/mnt/x', config)).toBe('/mnt/x');
  });
});
