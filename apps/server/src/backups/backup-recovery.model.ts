/** `recovery.json`, as the backup program writes it (system/programs/backup/recover.mts). */
export interface RecoveryRecord {
  id: string;
  status: 'succeeded' | 'failed';
  errorCode: string | null;
  archive: string;
  archiveTime: string;
  askedBy: number;
  finishedAt: string;
  accounts: { uid: number; name: string; items: string[] }[] | null;
}
