import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getOrganizationScopedModelNames } from '../../db/tenant-extension.js'
import { createIdentityFixture, createOwnerTestClient, resetDatabase } from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
})

afterAll(async () => {
  await ownerDatabase.$disconnect()
})

function jobData(organizationId, createdById, overrides = {}) {
  return {
    organizationId,
    reference: `JOB-2026-${crypto.randomUUID().slice(0, 6)}`,
    title: 'Fix basement pump',
    latitude: 51.5,
    longitude: -0.12,
    status: 'PENDING',
    currentAssigneeId: null,
    createdById,
    version: 1,
    dueAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  }
}

function attachmentData(job, uploaderId, overrides = {}) {
  return {
    organizationId: job.organizationId,
    jobId: job.id,
    uploaderId,
    fileKey: crypto.randomUUID(),
    contentType: 'image/jpeg',
    sizeBytes: 1024,
    ...overrides,
  }
}

async function fixture() {
  const identity = await createIdentityFixture(ownerDatabase)
  const job = await ownerDatabase.job.create({
    data: jobData(identity.organization.id, identity.user.id),
  })
  return { ...identity, job }
}

describe('Attachment content-type allowlist CHECK', () => {
  it('rejects a content type outside the allowlist', async () => {
    const { job, user } = await fixture()

    await expect(
      ownerDatabase.attachment.create({
        data: attachmentData(job, user.id, { contentType: 'text/html' }),
      }),
    ).rejects.toThrow()
  })

  it('accepts every allowlisted content type', async () => {
    const { job, user } = await fixture()

    for (const contentType of ['image/jpeg', 'image/png', 'image/webp']) {
      await expect(
        ownerDatabase.attachment.create({ data: attachmentData(job, user.id, { contentType }) }),
      ).resolves.toBeDefined()
    }
  })
})

describe('Attachment size CHECK', () => {
  it('rejects zero, negative, and oversize declarations', async () => {
    const { job, user } = await fixture()

    for (const sizeBytes of [0, -1, 5 * 1024 * 1024 + 1]) {
      await expect(
        ownerDatabase.attachment.create({ data: attachmentData(job, user.id, { sizeBytes }) }),
      ).rejects.toThrow()
    }
  })

  it('accepts the size boundaries', async () => {
    const { job, user } = await fixture()

    await expect(
      ownerDatabase.attachment.create({ data: attachmentData(job, user.id, { sizeBytes: 1 }) }),
    ).resolves.toBeDefined()
    await expect(
      ownerDatabase.attachment.create({
        data: attachmentData(job, user.id, { sizeBytes: 5 * 1024 * 1024 }),
      }),
    ).resolves.toBeDefined()
  })
})

describe('Attachment file-key uniqueness and scoping', () => {
  it('rejects a duplicate file key inside one organization', async () => {
    const { job, user } = await fixture()
    const fileKey = crypto.randomUUID()
    await ownerDatabase.attachment.create({ data: attachmentData(job, user.id, { fileKey }) })

    await expect(
      ownerDatabase.attachment.create({ data: attachmentData(job, user.id, { fileKey }) }),
    ).rejects.toThrow()
  })

  it('allows the same file key in a different organization', async () => {
    const first = await fixture()
    const second = await fixture()
    const fileKey = crypto.randomUUID()

    await ownerDatabase.attachment.create({ data: attachmentData(first.job, first.user.id, { fileKey }) })
    await expect(
      ownerDatabase.attachment.create({ data: attachmentData(second.job, second.user.id, { fileKey }) }),
    ).resolves.toBeDefined()
  })

  it('rejects an empty file key', async () => {
    const { job, user } = await fixture()

    await expect(
      ownerDatabase.attachment.create({ data: attachmentData(job, user.id, { fileKey: '' }) }),
    ).rejects.toThrow()
  })

  it('rejects unknown organization, job, and uploader', async () => {
    const { job, user } = await fixture()

    await expect(
      ownerDatabase.attachment.create({
        data: attachmentData(job, user.id, {
          organizationId: '22222222-2222-2222-8222-222222222222',
        }),
      }),
    ).rejects.toThrow()
    await expect(
      ownerDatabase.attachment.create({
        data: attachmentData(job, user.id, {
          jobId: '11111111-1111-1111-8111-111111111111',
        }),
      }),
    ).rejects.toThrow()
    await expect(
      ownerDatabase.attachment.create({
        data: attachmentData(job, '33333333-3333-3333-8333-333333333333'),
      }),
    ).rejects.toThrow()
  })
})

describe('Attachment tenant scoping', () => {
  it('picks up Attachment in the derived scoped-model list', () => {
    expect(getOrganizationScopedModelNames().has('Attachment')).toBe(true)
  })

  it('starts every Attachment composite tenant index with organizationId', async () => {
    const rows = await ownerDatabase.$queryRaw`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'Attachment'
        AND indexdef ILIKE '%organizationId%'
    `

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const columns = row.indexdef.match(/\(([^)]+)\)/)[1]
      expect(columns.split(',')[0].trim().replaceAll('"', '')).toBe('organizationId')
    }
  })
})
