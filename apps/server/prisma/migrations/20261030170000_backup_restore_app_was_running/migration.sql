-- A restore back where it was of a running app: "Apply the restored settings" (docs/plans/simpler_backups.md).
ALTER TABLE "BackupRestore" ADD COLUMN "appWasRunning" BOOLEAN NOT NULL DEFAULT false;
