import type { BackupItem, BackupRestoreTarget } from '@homelab/shared';

/** A service that can be backed up: installed, and its recipe has a backup. */
export interface BackupableService {
  id: string;
  catalogId: string;
  name: string;
  /** The folder fields its recipe backs up. */
  folders: string[];
}

/** An item as the page shows it: what it is called, and the folders a service may switch off. */
export interface ItemRow {
  item: BackupItem;
  /** A service's name; null for the platform (translated) and folders (their path). */
  name: string | null;
  /** A service's backup folder fields (more than one: each can be switched off). */
  folders: string[];
}

/** What a restore dialog chose. */
export interface RestoreChoice {
  itemId: string;
  archive: string;
  target: BackupRestoreTarget;
}

/** A setup's items: the services ticked (with folders switched off) and the folders added. */
export interface SetupItems {
  services: { serviceId: string; excludedFields: string[] }[];
  folders: string[];
}

/** What an item is called: a service's name, "This app", or a folder's path (machine text). */
export interface ItemLabel {
  text: string;
  /** Machine text (a path): shown left to right. */
  ltr: boolean;
}
