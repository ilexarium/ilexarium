import type { FileEntry, FileSummary } from '@ilex/shared';

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
