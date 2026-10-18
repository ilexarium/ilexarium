import type { FileEntry } from '@homelab/shared';

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
