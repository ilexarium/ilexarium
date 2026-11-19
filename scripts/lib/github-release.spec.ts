import {
  githubReleaseArgs,
  githubReleaseFiles,
  isGithubRepo,
  newerVersion,
} from './github-release.mjs';

const versionFiles = [
  '/r/download/v1.2.3/ilex-1.2.3.tar.gz',
  '/r/download/v1.2.3/manifest.json',
  '/r/download/v1.2.3/manifest.json.minisig',
];

describe('githubReleaseFiles', () => {
  it('adds latest.json, its signature and get-ilex.sh to the latest version', () => {
    expect(githubReleaseFiles({ versionFiles, folder: '/r', latest: true })).toEqual([
      ...versionFiles,
      '/r/latest/download/latest.json',
      '/r/latest/download/latest.json.minisig',
      '/r/get-ilex.sh',
    ]);
  });

  it('gives an older version only its own files, the notes among them', () => {
    const withNotes = [...versionFiles, '/r/download/v1.2.3/NOTES.md'];
    expect(githubReleaseFiles({ versionFiles: withNotes, folder: '/r', latest: false })).toEqual(
      withNotes,
    );
  });
});

describe('githubReleaseArgs', () => {
  it('creates the release on the pushed tag, with the notes as its text', () => {
    expect(
      githubReleaseArgs({
        repo: 'ilexarium/ilexarium',
        version: '1.2.3',
        paths: ['/s/a', '/s/b'],
        notesFile: '/s/NOTES.md',
        latest: true,
      }),
    ).toEqual([
      'release',
      'create',
      'v1.2.3',
      '--repo',
      'ilexarium/ilexarium',
      '--verify-tag',
      '--title',
      'v1.2.3',
      '--notes-file',
      '/s/NOTES.md',
      '--latest=true',
      '/s/a',
      '/s/b',
    ]);
  });

  it('passes empty notes without a notes file, and never marks an older version latest', () => {
    const args = githubReleaseArgs({ repo: 'o/r', version: '1.0.0', paths: [], latest: false });
    expect(args).toContain('--latest=false');
    expect(args.slice(args.indexOf('--notes'), args.indexOf('--notes') + 2)).toEqual([
      '--notes',
      '',
    ]);
    expect(args).not.toContain('--notes-file');
  });
});

describe('isGithubRepo', () => {
  it('accepts owner/name only', () => {
    expect(isGithubRepo('ilexarium/ilexarium')).toBe(true);
    for (const bad of ['ilexarium', 'a/b/c', '../x', 'o/r --repo', 'https://github.com/o/r', 7]) {
      expect(isGithubRepo(bad)).toBe(false);
    }
  });
});

describe('newerVersion', () => {
  it('compares each part as a number', () => {
    expect(newerVersion('0.2.10', '0.2.9')).toBe(true);
    expect(newerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(newerVersion('0.2.3', '0.2.3')).toBe(false);
    expect(newerVersion('0.2.3', '0.3.0')).toBe(false);
  });
});
