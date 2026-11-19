export function isGithubRepo(value: unknown): value is string;
export function newerVersion(a: string, b: string): boolean;
export function githubReleaseFiles(options: {
  versionFiles: string[];
  folder: string;
  latest: boolean;
}): string[];
export function githubReleaseArgs(options: {
  repo: string;
  version: string;
  paths: string[];
  notesFile?: string;
  latest: boolean;
}): string[];
