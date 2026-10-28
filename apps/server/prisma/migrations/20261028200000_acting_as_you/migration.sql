-- Acting as you (docs/plans/acting_as_you.md): apps are Compose folders, not database records.
-- Backup items of installed services go with the services (their archives stay on the disk).
DELETE FROM "BackupItem" WHERE "kind" = 'service';

-- AlterEnum
BEGIN;
CREATE TYPE "BackupItemKind_new" AS ENUM ('platform', 'app', 'folder');
ALTER TABLE "BackupItem" ALTER COLUMN "kind" TYPE "BackupItemKind_new" USING ("kind"::text::"BackupItemKind_new");
ALTER TYPE "BackupItemKind" RENAME TO "BackupItemKind_old";
ALTER TYPE "BackupItemKind_new" RENAME TO "BackupItemKind";
DROP TYPE "BackupItemKind_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Service" DROP CONSTRAINT "Service_createdById_fkey";

-- DropForeignKey
ALTER TABLE "ServiceSecret" DROP CONSTRAINT "ServiceSecret_serviceId_fkey";

-- DropForeignKey
ALTER TABLE "ServiceJob" DROP CONSTRAINT "ServiceJob_serviceId_fkey";

-- DropForeignKey
ALTER TABLE "ServiceJob" DROP CONSTRAINT "ServiceJob_startedById_fkey";

-- DropForeignKey
ALTER TABLE "BackupItem" DROP CONSTRAINT "BackupItem_serviceId_fkey";

-- DropIndex
DROP INDEX "BackupItem_serviceId_idx";

-- AlterTable
ALTER TABLE "BackupItem" DROP COLUMN "excludedFields",
DROP COLUMN "serviceId",
ADD COLUMN     "excludedFolders" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "folders" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mode" TEXT,
ADD COLUMN     "project" TEXT,
ADD COLUMN     "skip" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "BackupRestore" DROP COLUMN "errorField",
DROP COLUMN "kind",
DROP COLUMN "target";

-- DropTable
DROP TABLE "Service";

-- DropTable
DROP TABLE "ServiceSecret";

-- DropTable
DROP TABLE "ServiceJob";

-- DropEnum
DROP TYPE "ServiceStatus";

-- DropEnum
DROP TYPE "JobKind";

-- DropEnum
DROP TYPE "BackupRestoreTarget";

-- CreateIndex
CREATE INDEX "BackupItem_project_idx" ON "BackupItem"("project");

