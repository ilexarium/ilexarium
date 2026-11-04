export interface ReleaseManifest {
  version: string;
  published: string;
  archive: string;
  sha256: string;
  size: number;
  notes?: 'NOTES.md';
}
