// backup/recover-model.mts — runs as root.
//
// Restoring Ilexarium from the backup disk: its types (erasable syntax only).

import type { Plan, Repository } from './model.mts';

export interface RecoverRequest {
  recoveryId: string;
  repository: string;
  passphrase: string;
  /** The newest backup of Ilexarium, as `recover-check` showed it and the person confirmed. */
  archive: string;
  /** The uid whose sudo started it (`askingAccount`), never from the app. */
  askedBy: number;
}

export interface RecoveredAccount {
  uid: number;
  /** The account's name on the old machine, as Borg stored it ('' when it isn't a Linux name). */
  name: string;
  /** The apps (by project) and folders whose files it owns. */
  items: string[];
}

/** What `recovery.json` holds: read by the app (its notice, its audit) and by `ilex-recover`. */
export interface RecoveryRecord {
  id: string;
  status: 'succeeded' | 'failed';
  errorCode: string | null;
  archive: string;
  archiveTime: string;
  repository: string;
  askedBy: number;
  startedAt: string;
  finishedAt: string;
  /** null: not checked (a failed recovery, or Borg couldn't list them). */
  accounts: RecoveredAccount[] | null;
}

/** What the backup holds, checked before anything here changes. */
export interface FromBackup {
  dump: string;
  plan: Plan;
  repository: Repository;
  key: Buffer | null;
  /** The disk is mounted somewhere else than when it was backed up. */
  moved: boolean;
}
