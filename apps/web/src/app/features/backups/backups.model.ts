import type { BackupItem, BackupItemUpdate } from '@laris/shared';

/** An item as the page shows it: what it is called. */
export interface ItemRow {
  item: BackupItem;
  /** An app's name; null for the platform (translated) and folders (their path). */
  name: string | null;
}

/** What a restore dialog chose: the backup, and where (null: back where it was). */
export interface RestoreChoice {
  itemId: string;
  archive: string;
  target: string | null;
}

/** An app item's folders, skips or mode changed. */
export interface ItemChange {
  itemId: string;
  change: BackupItemUpdate;
}

/** An item out of the plan; `deleteArchives` deletes its backups too. */
export interface ItemRemoval {
  itemId: string;
  deleteArchives: boolean;
}

/** A setup's items: the apps ticked and the folders added. */
export interface SetupItems {
  apps: string[];
  folders: string[];
}

/** What an item is called: an app's name, "This app", or a folder's path (machine text). */
export interface ItemLabel {
  text: string;
  /** Machine text (a path): shown left to right. */
  ltr: boolean;
}
