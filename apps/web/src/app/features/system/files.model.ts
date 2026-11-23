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

/** Files to upload; `replace` false: a name taken there is asked about. */
export interface UploadRequest {
  files: File[];
  replace: boolean;
  /** Where to; the folder shown when asked if not given. */
  folder?: string;
}

/** A file whose name was taken in the folder it went to: the page asks before replacing it. */
export interface UploadClash {
  folder: string;
  file: File;
}
