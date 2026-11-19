export function isGithubRepo(value: unknown): value is string;
export function githubReleaseFiles(options: {
  versionFiles: string[];
  folder: string;
  latest: boolean;
}): [string, string][];
export function githubReleaseArgs(options: {
  repo: string;
  version: string;
  paths: string[];
  notesFile?: string;
  latest: boolean;
}): string[];
