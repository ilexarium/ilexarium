-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('warning', 'critical');

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedById" UUID,
    "acknowledgedBy" TEXT,
    "lastSentAt" TIMESTAMPTZ(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertChannel" (
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "secrets" BYTEA,
    "lastProblem" TEXT,
    "lastProblemAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AlertChannel_pkey" PRIMARY KEY ("kind")
);

-- CreateIndex
CREATE INDEX "Alert_kind_subject_closedAt_idx" ON "Alert"("kind", "subject", "closedAt");

-- CreateIndex
CREATE INDEX "Alert_closedAt_idx" ON "Alert"("closedAt");
