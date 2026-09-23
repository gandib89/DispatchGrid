import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedDatabase } from '../../prisma/seed.js'
import { PROOF_MAX_SIZE_BYTES } from '../../../shared/job-schema.js'
import { prisma } from '../db/client.js'
import { createOwnerTestClient, resetDatabase } from '../test/helpers.js'
import { verifyPutRequest } from '../lib/files/signed-url.js'
import { issueUploadUrl } from './attachment-service.js'

const ownerDatabase = createOwnerTestClient()

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})

async function buildActor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  const membership = await ownerDatabase.membership.findFirstOrThrow({
    where: { userId: user.id },
    include: {
      role: { include: { rolePermissions: { include: { permission: true } } } },
    },
  })
  return {
    userId: user.id,
    organizationId: membership.organizationId,
    membershipId: membership.id,
    permissions: membership.role.rolePermissions.map((link) => link.permission.code),
  }
}

const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const agentEmail = 'agent@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

const validInput = { contentType: 'image/jpeg', sizeBytes: 2048 }

async function acceptedFixture(actor, agentId) {
  const job = await ownerDatabase.job.create({
    data: {
      organizationId: actor.organizationId,
      reference: 'JOB-2026-000201',
      title: 'Pump repair',
      latitude: 51.5,
      longitude: -0.12,
      status: 'ACCEPTED',
      currentAssigneeId: agentId,
      createdById: actor.userId,
      version: 3,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  })
  await ownerDatabase.assignment.create({
    data: {
      organizationId: actor.organizationId,
      jobId: job.id,
      agentId,
      state: 'ACCEPTED',
    },
  })
  return job
}

async function recordedAttachment(job, overrides = {}) {
  return ownerDatabase.attachment.create({
    data: {
      organizationId: job.organizationId,
      jobId: job.id,
      uploaderId: job.currentAssigneeId,
      fileKey: crypto.randomUUID(),
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      ...overrides,
    },
  })
}

describe('issueUploadUrl happy path', () => {
  it('records the durable attachment and returns a verifiable five-minute PUT for the assignee', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)

    const before = Date.now()
    const { attachment, upload, replay } = await issueUploadUrl(agent, job.id, validInput)

    expect(replay).toBe(false)
    expect(attachment.organizationId).toBe(dispatcher.organizationId)
    expect(attachment.jobId).toBe(job.id)
    expect(attachment.uploaderId).toBe(agent.userId)
    expect(attachment.fileKey).toMatch(/^[0-9a-f-]{36}$/i)
    expect(attachment.contentType).toBe('image/jpeg')
    expect(attachment.sizeBytes).toBe(2048)
    expect(attachment.createdAt).toBeDefined()

    const rows = await ownerDatabase.attachment.findMany({ where: { jobId: job.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].fileKey).toBe(attachment.fileKey)

    expect(upload.method).toBe('PUT')
    expect(upload.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 1000)
    expect(upload.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000)
    expect(upload.conditions).toEqual({ contentType: 'image/jpeg', sizeBytes: 2048 })

    const request = {
      key: attachment.fileKey,
      method: upload.method,
      contentType: upload.conditions.contentType,
      sizeBytes: upload.conditions.sizeBytes,
      expiresAt: upload.expiresAt,
      signature: upload.signature,
    }
    expect(verifyPutRequest(request)).toEqual({ ok: true })
    expect(verifyPutRequest({ ...request, contentType: 'image/png' })).toEqual({
      ok: false,
      reason: 'condition_mismatch',
    })
    expect(verifyPutRequest({ ...request, sizeBytes: 4096 })).toEqual({
      ok: false,
      reason: 'condition_mismatch',
    })
  })

  it('replays the same attachment and URL for the same idempotency key', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)

    const first = await issueUploadUrl(agent, job.id, validInput, { key: 'upload-1' })
    const second = await issueUploadUrl(agent, job.id, validInput, { key: 'upload-1' })

    expect(second.replay).toBe(true)
    expect(second.attachment).toEqual(first.attachment)
    expect(second.upload).toEqual(first.upload)
    expect(await ownerDatabase.attachment.count({ where: { jobId: job.id } })).toBe(1)
  })
})

describe('issueUploadUrl refusals', () => {
  it('denies a non-assignee in the same organization with forbidden and records nothing', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const shadow = await buildActor(shadowEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)
    const outsider = { ...shadow, organizationId: dispatcher.organizationId }

    const error = await issueUploadUrl(outsider, job.id, validInput).catch((e) => e)
    expect(error.code).toBe('forbidden')
    expect(error.status).toBe(403)
    expect(await ownerDatabase.attachment.count({ where: { jobId: job.id } })).toBe(0)
  })

  it('returns 404 cross-org before any permission or ownership check', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const shadow = await buildActor(shadowEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)

    const error = await issueUploadUrl(shadow, job.id, validInput).catch((e) => e)
    expect(error.code).toBe('not_found')
    expect(error.status).toBe(404)

    const withoutPermission = { ...shadow, permissions: [] }
    const denied = await issueUploadUrl(withoutPermission, job.id, validInput).catch((e) => e)
    expect(denied.code).toBe('not_found')
    expect(denied.status).toBe(404)
    expect(await ownerDatabase.attachment.count()).toBe(0)
  })

  it('refuses an off-allowlist content type with its own error code', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)

    const error = await issueUploadUrl(agent, job.id, {
      contentType: 'text/html',
      sizeBytes: 2048,
    }).catch((e) => e)
    expect(error.code).toBe('unsupported_media_type')
    expect(error.status).toBe(415)
    expect(await ownerDatabase.attachment.count()).toBe(0)
  })

  it('refuses an oversize declaration with its own error code', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)

    const error = await issueUploadUrl(agent, job.id, {
      contentType: 'image/jpeg',
      sizeBytes: PROOF_MAX_SIZE_BYTES + 1,
    }).catch((e) => e)
    expect(error.code).toBe('file_too_large')
    expect(error.status).toBe(413)
    expect(await ownerDatabase.attachment.count()).toBe(0)
  })

  it('refuses issuance at or above the three-attachment cap with its own error code', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)

    await recordedAttachment(job)
    await recordedAttachment(job)
    const third = await issueUploadUrl(agent, job.id, validInput)
    expect(third.replay).toBe(false)
    expect(await ownerDatabase.attachment.count({ where: { jobId: job.id } })).toBe(3)

    const error = await issueUploadUrl(agent, job.id, validInput).catch((e) => e)
    expect(error.code).toBe('attachment_limit_reached')
    expect(error.status).toBe(409)
    expect(await ownerDatabase.attachment.count({ where: { jobId: job.id } })).toBe(3)
  })

  it('denies the assignee without the job.respond permission', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)
    const withoutPermission = {
      ...agent,
      permissions: agent.permissions.filter((code) => code !== 'job.respond'),
    }

    const error = await issueUploadUrl(withoutPermission, job.id, validInput).catch((e) => e)
    expect(error.code).toBe('forbidden')
    expect(error.status).toBe(403)
    expect(await ownerDatabase.attachment.count()).toBe(0)
  })
})
