-- Folders not ticked are simply not backed up (docs/plans/simpler_backups.md).
ALTER TABLE "BackupItem" DROP COLUMN "excludedFolders";
