import { joinPath, normalizePath, renameTarget } from './files-paths';

describe('paths', () => {
  it.each([
    ['/home//anna/./x', '/home/anna/x'],
    ['/home/anna/../..', '/'],
    ['/../etc', '/etc'],
  ])('normalizePath(%s) = %s', (path, expected) => expect(normalizePath(path)).toBe(expected));

  it('joinPath: a name in a folder, resolved', () => {
    expect(joinPath('/home/anna', 'x')).toBe('/home/anna/x');
    expect(joinPath('/', '../etc')).toBe('/etc');
  });

  it('renameTarget: a name stays in the folder; a path from there, or from /', () => {
    expect(renameTarget('/home/anna', 'new.txt')).toBe('/home/anna/new.txt');
    expect(renameTarget('/home/anna', ' ../bob/x ')).toBe('/home/bob/x');
    expect(renameTarget('/home/anna', '/srv/music/x')).toBe('/srv/music/x');
  });
});
