import type { FileEntry, FileSummary } from '@ilex/shared';

/** An upload in progress or finished. */
export interface Upload {
  id: number;
  name: string;
  /** 0–1. */
  progress: number;
  state: 'uploading' | 'done' | 'failed';
}

/** What the user asked for on one entry of the list. */
export interface FileAction {
  kind: 'rename' | 'delete';
  entry: FileEntry;
}

/** The name dialog: a new folder, or renaming/moving an entry. */
export type NameRequest = { kind: 'newFolder' } | { kind: 'rename'; entry: FileEntry };

/** A delete waiting for its confirmation: the entry, and how much it holds (null while counted). */
export interface FileDeletion {
  entry: FileEntry;
  summary: FileSummary | null;
}

/** Files to upload into the folder shown; `replace` false: a name taken there is asked about. */
export interface UploadRequest {
  files: File[];
  replace: boolean;
}
