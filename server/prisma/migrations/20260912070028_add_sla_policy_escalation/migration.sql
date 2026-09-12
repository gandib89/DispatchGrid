-- CreateEnum
CREATE TYPE "EscalationThreshold" AS ENUM ('WARNING', 'BREACH');

-- CreateTable
CREATE TABLE "SlaPolicy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "warningMinutesBefore" INTEGER NOT NULL,
    "breachMinutesAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Escalation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "threshold" "EscalationThreshold" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Escalation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlaPolicy_organizationId_createdAt_idx" ON "SlaPolicy"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SlaPolicy_organizationId_name_key" ON "SlaPolicy"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Escalation_organizationId_jobId_createdAt_idx" ON "Escalation"("organizationId", "jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Escalation_jobId_threshold_key" ON "Escalation"("jobId", "threshold");

-- AddForeignKey
ALTER TABLE "SlaPolicy" ADD CONSTRAINT "SlaPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database-enforced SLA truth: the nonnegative-threshold CHECK and the
-- escalation immutability trigger are the load-bearing guarantees. Prisma's
-- schema language cannot express them, so they live here as custom SQL
-- (same pattern as the B07 job-domain migration).

ALTER TABLE "SlaPolicy" ADD CONSTRAINT "SlaPolicy_thresholds_nonnegative" CHECK (
  "warningMinutesBefore" >= 0 AND "breachMinutesAfter" >= 0
);

CREATE OR REPLACE FUNCTION reject_escalation_write() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Escalation rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "escalation_no_update_delete"
  BEFORE UPDATE OR DELETE ON "Escalation"
  FOR EACH ROW EXECUTE FUNCTION reject_escalation_write();
