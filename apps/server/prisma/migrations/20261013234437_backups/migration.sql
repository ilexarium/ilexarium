-- CreateEnum
CREATE TYPE "BackupItemKind" AS ENUM ('platform', 'service', 'folder');

-- CreateEnum
CREATE TYPE "BackupTrigger" AS ENUM ('scheduled', 'manual');

-- CreateEnum
CREATE TYPE "BackupRunStatus" AS ENUM ('running', 'ok', 'warning', 'failed');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('ok', 'warning', 'failed');

-- CreateEnum
CREATE TYPE "BackupRestoreTarget" AS ENUM ('inPlace', 'newFolder');

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'restore';

-- CreateTable
CREATE TABLE "BackupPlan" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "destination" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "schedule" JSONB NOT NULL,
    "retention" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BackupPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupItem" (
    "id" UUID NOT NULL,
    "kind" "BackupItemKind" NOT NULL,
    "serviceId" UUID,
    "path" TEXT,
    "excludedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "removedAt" TIMESTAMPTZ(3),
    "archives" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivesAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" UUID NOT NULL,
    "trigger" "BackupTrigger" NOT NULL,
    "itemId" UUID,
    "status" "BackupRunStatus" NOT NULL,
    "errorCode" TEXT,
    "output" TEXT NOT NULL DEFAULT '',
    "startedById" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupItemResult" (
    "runId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "status" "BackupStatus" NOT NULL,
    "errorCode" TEXT,
    "archive" TEXT,
    "originalBytes" BIGINT,
    "addedBytes" BIGINT,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "BackupItemResult_pkey" PRIMARY KEY ("runId","itemId")
);

-- CreateTable
CREATE TABLE "BackupCheck" (
    "id" UUID NOT NULL,
    "full" BOOLEAN NOT NULL,
    "status" "BackupStatus" NOT NULL,
    "errorCode" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BackupCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRestore" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "archive" TEXT NOT NULL,
    "target" "BackupRestoreTarget" NOT NULL,
    "targetPath" TEXT,
    "setAside" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "setAsideDeletedAt" TIMESTAMPTZ(3),
    "kind" "JobKind" NOT NULL DEFAULT 'restore',
    "status" "JobStatus" NOT NULL,
    "phase" TEXT,
    "errorCode" TEXT,
    "errorField" TEXT,
    "output" TEXT NOT NULL DEFAULT '',
    "startedById" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BackupRestore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupItem_serviceId_idx" ON "BackupItem"("serviceId");

-- CreateIndex
CREATE INDEX "BackupRun_startedAt_idx" ON "BackupRun"("startedAt");

-- CreateIndex
CREATE INDEX "BackupItemResult_itemId_idx" ON "BackupItemResult"("itemId");

-- CreateIndex
CREATE INDEX "BackupCheck_finishedAt_idx" ON "BackupCheck"("finishedAt");

-- CreateIndex
CREATE INDEX "BackupRestore_startedAt_idx" ON "BackupRestore"("startedAt");

-- AddForeignKey
ALTER TABLE "BackupItem" ADD CONSTRAINT "BackupItem_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupRun" ADD CONSTRAINT "BackupRun_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupItemResult" ADD CONSTRAINT "BackupItemResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BackupRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupItemResult" ADD CONSTRAINT "BackupItemResult_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "BackupItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupRestore" ADD CONSTRAINT "BackupRestore_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "BackupItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupRestore" ADD CONSTRAINT "BackupRestore_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
