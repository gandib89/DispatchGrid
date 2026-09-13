-- CreateTable
CREATE TABLE "LocationPing" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "jobId" UUID,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationPing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LocationPing_organizationId_agentId_recordedAt_idx" ON "LocationPing"("organizationId", "agentId", "recordedAt");

-- CreateIndex
CREATE INDEX "LocationPing_organizationId_recordedAt_idx" ON "LocationPing"("organizationId", "recordedAt");

-- AddForeignKey
ALTER TABLE "LocationPing" ADD CONSTRAINT "LocationPing_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationPing" ADD CONSTRAINT "LocationPing_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database-enforced ping truth: the coordinate-range, nonnegative-accuracy,
-- and recordedAt-presence CHECKs are the load-bearing guarantees. Prisma's
-- schema language cannot express them, so they live here as custom SQL
-- (same pattern as the B07 job-domain and B12 SLA migrations).

ALTER TABLE "LocationPing" ADD CONSTRAINT "LocationPing_coordinates_valid" CHECK (
  "latitude" >= -90 AND "latitude" <= 90
  AND "longitude" >= -180 AND "longitude" <= 180
);

ALTER TABLE "LocationPing" ADD CONSTRAINT "LocationPing_accuracy_nonnegative" CHECK (
  "accuracy" >= 0
);

ALTER TABLE "LocationPing" ADD CONSTRAINT "LocationPing_recordedAt_present" CHECK (
  "recordedAt" IS NOT NULL
);
