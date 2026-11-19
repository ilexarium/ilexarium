// A published version as a GitHub release: the same files as the release folder's
// download/v<version>/, plus — for the latest — latest.json(.minisig) and get-ilex.sh, so GitHub's
// releases/latest/download/<file> answers what machines and get-ilex.sh ask for.
import { join } from 'node:path';

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export const isGithubRepo = (value) => typeof value === 'string' && REPO.test(value);

export const newerVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// GitHub names a file by its own name: these already carry the names machines ask for.
export function githubReleaseFiles({ versionFiles, folder, latest }) {
  if (!latest) return versionFiles;
  const download = join(folder, 'latest', 'download');
  return [
    ...versionFiles,
    join(download, 'latest.json'),
    join(download, 'latest.json.minisig'),
    join(folder, 'get-ilex.sh'),
  ];
}

export function githubReleaseArgs({ repo, version, paths, notesFile, latest }) {
  return [
    'release',
    'create',
    `v${version}`,
    '--repo',
    repo,
    '--verify-tag',
    '--title',
    `v${version}`,
    // Without notes gh would open an editor.
    ...(notesFile ? ['--notes-file', notesFile] : ['--notes', '']),
    `--latest=${latest}`,
    ...paths,
  ];
}
