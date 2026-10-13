-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('installing', 'installed', 'failed', 'removing', 'removed');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('deploy', 'remove');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('running', 'succeeded', 'failed', 'interrupted');

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL,
    "catalogId" TEXT NOT NULL,
    "catalogVersion" TEXT NOT NULL,
    "status" "ServiceStatus" NOT NULL,
    "settings" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceSecret" (
    "serviceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" BYTEA NOT NULL,

    CONSTRAINT "ServiceSecret_pkey" PRIMARY KEY ("serviceId","key")
);

-- CreateTable
CREATE TABLE "ServiceJob" (
    "id" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "kind" "JobKind" NOT NULL,
    "status" "JobStatus" NOT NULL,
    "phase" TEXT,
    "errorCode" TEXT,
    "errorField" TEXT,
    "output" TEXT NOT NULL DEFAULT '',
    "startedById" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ServiceJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Service_catalogId_key" ON "Service"("catalogId");

-- CreateIndex
CREATE INDEX "ServiceJob_serviceId_startedAt_idx" ON "ServiceJob"("serviceId", "startedAt");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceSecret" ADD CONSTRAINT "ServiceSecret_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceJob" ADD CONSTRAINT "ServiceJob_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceJob" ADD CONSTRAINT "ServiceJob_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
