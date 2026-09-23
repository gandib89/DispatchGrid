-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "uploaderId" UUID NOT NULL,
    "fileKey" VARCHAR(512) NOT NULL,
    "contentType" VARCHAR(128) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attachment_organizationId_jobId_createdAt_idx" ON "Attachment"("organizationId", "jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_organizationId_fileKey_key" ON "Attachment"("organizationId", "fileKey");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database-enforced attachment truth: the content-type allowlist and the size
-- bound are load-bearing guarantees (same pattern as the job-domain and
-- location-ping CHECKs). Prisma's schema language cannot express them, so
-- they live here as custom SQL. The per-job count cap stays service-level.

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_content_type_allowed" CHECK (
  "contentType" IN ('image/jpeg', 'image/png', 'image/webp')
);

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_size_valid" CHECK (
  "sizeBytes" > 0 AND "sizeBytes" <= 5242880
);

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_file_key_nonempty" CHECK (
  "fileKey" <> ''
);
