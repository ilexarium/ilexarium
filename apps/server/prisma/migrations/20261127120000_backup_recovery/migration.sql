-- CreateTable
CREATE TABLE "BackupRecovery" (
    "id" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BackupRecovery_pkey" PRIMARY KEY ("id")
);
