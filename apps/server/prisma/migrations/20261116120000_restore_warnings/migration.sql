-- AlterTable
ALTER TABLE "BackupRestore" ADD COLUMN     "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[];
