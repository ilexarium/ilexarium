-- CreateTable
CREATE TABLE "UpdateCheck" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "checkAutomatically" BOOLEAN NOT NULL DEFAULT true,
    "checkedAt" TIMESTAMPTZ(3),
    "checkError" TEXT,
    "newestPublished" TEXT,
    "availableVersion" TEXT,
    "availablePublished" TEXT,
    "availableNotes" TEXT,

    CONSTRAINT "UpdateCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateRun" (
    "id" UUID NOT NULL,
    "fromVersion" TEXT NOT NULL,
    "toVersion" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "ip" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "outcome" TEXT,
    "error" TEXT,

    CONSTRAINT "UpdateRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UpdateRun_startedAt_idx" ON "UpdateRun"("startedAt");
