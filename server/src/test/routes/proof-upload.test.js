import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { PROOF_MAX_SIZE_BYTES } from '../../../../shared/job-schema.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import { clearBoardCache } from '../../routes/jobs.js'
import { acceptJob, assignJob } from '../../services/assignment-service.js'
import { createOwnerTestClient, createUserFixture, resetDatabase } from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const agentEmail = 'agent@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

beforeEach(async () => {
  clearBoardCache()
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})

async function tokenFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  return signAccessToken(user.id)
}

async function actorFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  const membership = await ownerDatabase.membership.findFirstOrThrow({
    where: { userId: user.id },
    include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
  })
  return {
    user,
    actor: {
      userId: user.id,
      organizationId: membership.organizationId,
      membershipId: membership.id,
      roleId: membership.roleId,
      roleName: membership.role.name,
      permissions: membership.role.rolePermissions.map((link) => link.permission.code),
    },
  }
}

async function createJobViaApi(token) {
  const response = await request(app)
    .post('/api/v1/jobs')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', crypto.randomUUID())
    .send({
      title: 'Fix basement pump',
      latitude: 51.5,
      longitude: -0.12,
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
  expect(response.status).toBe(201)
  return response.body.job
}

async function createSecondAgent() {
  const organization = await ownerDatabase.organization.findFirstOrThrow({
    where: { slug: 'dispatchgrid-demo' },
  })
  const role = await ownerDatabase.role.findFirstOrThrow({
    where: { organizationId: organization.id, name: 'AGENT' },
  })
  const user = await createUserFixture(ownerDatabase)
  await ownerDatabase.membership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      roleId: role.id,
      isAvailable: true,
    },
  })
  return { user, token: signAccessToken(user.id) }
}

async function progressToAccepted(jobId) {
  const { actor: dispatcher } = await actorFor(dispatcherEmail)
  const { user: agentUser, actor: agent } = await actorFor(agentEmail)
  await assignJob(dispatcher, jobId, agentUser.id, 1)
  const accepted = await acceptJob(agent, jobId, { version: 2 })
  return { job: accepted.job, agentUser }
}

function uploadBody(overrides = {}) {
  return { contentType: 'image/jpeg', sizeBytes: 2048, ...overrides }
}

function postUploadUrl(token, jobId, body = uploadBody()) {
  return request(app)
    .post(`/api/v1/jobs/${jobId}/upload-url`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

const EXPECTED_ATTACHMENT_KEYS = [
  'contentType',
  'createdAt',
  'fileKey',
  'id',
  'jobId',
  'organizationId',
  'sizeBytes',
  'updatedAt',
  'uploaderId',
].sort()

const EXPECTED_UPLOAD_KEYS = ['conditions', 'expiresAt', 'method', 'url'].sort()

describe('POST /api/v1/jobs/:id/upload-url', () => {
  it('issues a signed PUT and records the attachment for the current assignee', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    const { job } = await progressToAccepted(created.id)

    const response = await postUploadUrl(agentToken, created.id)

    expect(response.status).toBe(201)
    expect(Object.keys(response.body.attachment).sort()).toEqual(EXPECTED_ATTACHMENT_KEYS)
    expect(Object.keys(response.body.upload).sort()).toEqual(EXPECTED_UPLOAD_KEYS)
    expect(response.body.attachment).toMatchObject({
      jobId: created.id,
      uploaderId: job.currentAssigneeId,
      contentType: 'image/jpeg',
      sizeBytes: 2048,
    })
    expect(response.body.attachment.fileKey).toBeTruthy()
    expect(response.body.upload.method).toBe('PUT')
    expect(response.body.upload.url).toContain(encodeURIComponent(response.body.attachment.fileKey))
    expect(response.body.upload.conditions).toEqual({
      contentType: 'image/jpeg',
      sizeBytes: 2048,
    })

    const rows = await ownerDatabase.attachment.findMany({ where: { jobId: created.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].fileKey).toBe(response.body.attachment.fileKey)
  })

  it('denies a non-assignee with forbidden and records nothing', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToAccepted(created.id)
    const { token: otherToken } = await createSecondAgent()

    const denied = await postUploadUrl(otherToken, created.id)

    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('forbidden')
    expect(await ownerDatabase.attachment.count({ where: { jobId: created.id } })).toBe(0)
  })

  it('returns 404 cross-org (scope before permission) and 401 anonymous', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToAccepted(created.id)

    const shadowToken = await tokenFor(shadowEmail)
    const crossOrg = await postUploadUrl(shadowToken, created.id)
    expect(crossOrg.status).toBe(404)
    expect(crossOrg.body.error.code).toBe('not_found')

    const anonymous = await request(app)
      .post(`/api/v1/jobs/${created.id}/upload-url`)
      .send(uploadBody())
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')
  })

  it('refuses an off-allowlist content type with 415 unsupported_media_type', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToAccepted(created.id)

    const denied = await postUploadUrl(agentToken, created.id, uploadBody({ contentType: 'text/html' }))

    expect(denied.status).toBe(415)
    expect(denied.body.error.code).toBe('unsupported_media_type')
    expect(await ownerDatabase.attachment.count({ where: { jobId: created.id } })).toBe(0)
  })

  it('refuses an oversize declaration with 413 file_too_large', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToAccepted(created.id)

    const denied = await postUploadUrl(
      agentToken,
      created.id,
      uploadBody({ sizeBytes: PROOF_MAX_SIZE_BYTES + 1 }),
    )

    expect(denied.status).toBe(413)
    expect(denied.body.error.code).toBe('file_too_large')
    expect(await ownerDatabase.attachment.count({ where: { jobId: created.id } })).toBe(0)
  })

  it('refuses issuance at the three-attachment cap with 409 attachment_limit_reached', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    const { job, agentUser } = await progressToAccepted(created.id)

    for (let i = 0; i < 3; i += 1) {
      await ownerDatabase.attachment.create({
        data: {
          organizationId: job.organizationId,
          jobId: created.id,
          uploaderId: agentUser.id,
          fileKey: crypto.randomUUID(),
          contentType: 'image/jpeg',
          sizeBytes: 1024,
        },
      })
    }

    const denied = await postUploadUrl(agentToken, created.id)

    expect(denied.status).toBe(409)
    expect(denied.body.error.code).toBe('attachment_limit_reached')
    expect(await ownerDatabase.attachment.count({ where: { jobId: created.id } })).toBe(3)
  })

  it('yields 400 for malformed input', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToAccepted(created.id)

    const missingSize = await postUploadUrl(agentToken, created.id, { contentType: 'image/jpeg' })
    expect(missingSize.status).toBe(400)
    expect(missingSize.body.error.code).toBe('validation_error')

    const zeroSize = await postUploadUrl(agentToken, created.id, uploadBody({ sizeBytes: 0 }))
    expect(zeroSize.status).toBe(400)

    const unknown = await postUploadUrl(agentToken, created.id, uploadBody({ bogus: true }))
    expect(unknown.status).toBe(400)
  })
})
