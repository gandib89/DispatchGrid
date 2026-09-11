-- CreateEnum
CREATE TYPE "JobPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "SlaState" AS ENUM ('OK', 'WARNING', 'BREACHED');

-- CreateEnum
CREATE TYPE "AssignmentState" AS ENUM ('OFFERED', 'ACCEPTED', 'DECLINED', 'REVOKED', 'COMPLETED');

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reference" VARCHAR(32) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "address" VARCHAR(255),
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "slaState" "SlaState" NOT NULL DEFAULT 'OK',
    "currentAssigneeId" UUID,
    "createdById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "dueAt" TIMESTAMPTZ(6) NOT NULL,
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "state" "AssignmentState" NOT NULL DEFAULT 'OFFERED',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "actorUserId" UUID,
    "fromStatus" "JobStatus",
    "toStatus" "JobStatus" NOT NULL,
    "reason" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_organizationId_status_priority_dueAt_idx" ON "Job"("organizationId", "status", "priority", "dueAt");

-- CreateIndex
CREATE INDEX "Job_organizationId_slaState_dueAt_idx" ON "Job"("organizationId", "slaState", "dueAt");

-- CreateIndex
CREATE INDEX "Job_organizationId_currentAssigneeId_status_idx" ON "Job"("organizationId", "currentAssigneeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Job_organizationId_reference_key" ON "Job"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "Assignment_organizationId_jobId_createdAt_idx" ON "Assignment"("organizationId", "jobId", "createdAt");

-- CreateIndex
CREATE INDEX "Assignment_organizationId_agentId_state_idx" ON "Assignment"("organizationId", "agentId", "state");

-- CreateIndex
CREATE INDEX "JobEvent_organizationId_jobId_createdAt_idx" ON "JobEvent"("organizationId", "jobId", "createdAt");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database-enforced job truth: these CHECKs, the partial unique index, and the
-- immutability trigger are the load-bearing guarantees. Prisma's schema language
-- cannot express them, so they live here as custom SQL.

ALTER TABLE "Job" ADD CONSTRAINT "Job_coordinates_valid" CHECK (
  "latitude" >= -90 AND "latitude" <= 90
  AND "longitude" >= -180 AND "longitude" <= 180
);

ALTER TABLE "Job" ADD CONSTRAINT "Job_status_assignee_consistent" CHECK (
  (
    "status" IN ('PENDING', 'CANCELLED')
    AND "currentAssigneeId" IS NULL
  )
  OR (
    "status" IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED')
    AND "currentAssigneeId" IS NOT NULL
  )
);

ALTER TABLE "Job" ADD CONSTRAINT "Job_completed_at_consistent" CHECK (
  ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)
);

ALTER TABLE "Job" ADD CONSTRAINT "Job_version_positive" CHECK ("version" >= 1);

CREATE UNIQUE INDEX "assignment_one_active_per_job"
  ON "Assignment"("jobId")
  WHERE "state" IN ('OFFERED', 'ACCEPTED');

CREATE OR REPLACE FUNCTION reject_job_event_write() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'JobEvent rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "job_event_no_update_delete"
  BEFORE UPDATE OR DELETE ON "JobEvent"
  FOR EACH ROW EXECUTE FUNCTION reject_job_event_write();
