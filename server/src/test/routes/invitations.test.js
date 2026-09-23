import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import { QUEUE_NAMES, closeQueues, getQueue } from '../../lib/queue/index.js'
import { createOwnerTestClient, resetDatabase } from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

const adminEmail = 'admin@dispatchgrid.local'
const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const agentEmail = 'agent@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

const HOUR_MS = 60 * 60 * 1000

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect(), closeQueues()])
})

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

async function tokenFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  return signAccessToken(user.id)
}

async function orgIdFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  const membership = await ownerDatabase.membership.findFirstOrThrow({
    where: { userId: user.id },
  })
  return membership.organizationId
}

function invitationsPath(orgId, invitationId) {
  const base = `/api/v1/organizations/${orgId}/invitations`
  return invitationId ? `${base}/${invitationId}` : base
}

async function postInvite(token, orgId, body, headers = {}) {
  return request(app)
    .post(invitationsPath(orgId))
    .set('Authorization', `Bearer ${token}`)
    .set(headers)
    .send(body)
}

async function deleteInvite(token, orgId, invitationId) {
  return request(app)
    .delete(invitationsPath(orgId, invitationId))
    .set('Authorization', `Bearer ${token}`)
}

async function issueInvite(token, orgId, email = 'new.member@example.test') {
  return postInvite(token, orgId, { email })
}

async function invitationJob(invitationId) {
  const jobs = await getQueue(QUEUE_NAMES.jobEvents).getJobs(['waiting', 'delayed', 'active'])
  return jobs.find((job) => job.data?.invitationId === invitationId) ?? null
}

describe('POST /api/v1/organizations/:orgId/invitations', () => {
  it('creates a pending invitation with 201 exposing only safe fields', async () => {
    const token = await tokenFor(adminEmail)
    const orgId = await orgIdFor(adminEmail)
    const before = Date.now()

    const response = await issueInvite(token, orgId)

    expect(response.status).toBe(201)
    expect(Object.keys(response.body.invitation).sort()).toEqual(
      [
        'acceptedAt',
        'createdAt',
        'email',
        'expiresAt',
        'id',
        'organizationId',
        'updatedAt',
      ].sort(),
    )
    expect(response.body.invitation).toMatchObject({
      organizationId: orgId,
      email: 'new.member@example.test',
      acceptedAt: null,
    })
    const ttlMs = new Date(response.body.invitation.expiresAt).getTime() - before
    expect(ttlMs).toBeGreaterThanOrEqual(71 * HOUR_MS)
    expect(ttlMs).toBeLessThanOrEqual(73 * HOUR_MS)

    const raw = JSON.stringify(response.body)
    expect(raw).not.toContain('token')
    expect(raw).not.toContain('tokenHash')
    const row = await ownerDatabase.invitation.findFirst({
      where: { id: response.body.invitation.id },
    })
    expect(row).not.toBeNull()
    expect(Object.keys(row)).not.toContain('token')
    expect(raw).not.toContain(row.tokenHash)
  })

  it('enqueues delivery after commit with the plaintext token and request correlation', async () => {
    const token = await tokenFor(adminEmail)
    const orgId = await orgIdFor(adminEmail)
    const requestId = `req-invite-${crypto.randomUUID()}`

    const response = await postInvite(
      token,
      orgId,
      { email: 'queued.member@example.test' },
      { 'x-request-id': requestId },
    )

    expect(response.status).toBe(201)
    const invitationId = response.body.invitation.id
    const job = await invitationJob(invitationId)
    expect(job).not.toBeNull()
    expect(job.name).toBe('invite-delivery')
    expect(job.data).toMatchObject({
      type: 'invite-delivery',
      invitationId,
      organizationId: orgId,
      email: 'queued.member@example.test',
      requestId,
      expiresAt: response.body.invitation.expiresAt,
    })
    expect(typeof job.data.token).toBe('string')

    // The durable row and the queue payload agree on the hash: the DB never
    // sees plaintext, the queue carries the only plaintext.
    const row = await ownerDatabase.invitation.findFirstOrThrow({
      where: { id: invitationId },
    })
    expect(row.tokenHash).toBe(sha256(job.data.token))
    expect(response.body.invitation).not.toHaveProperty('token')
  })

  it('refuses writes without the invite capability', async () => {
    const orgId = await orgIdFor(adminEmail)

    for (const email of [dispatcherEmail, agentEmail]) {
      const token = await tokenFor(email)
      const response = await issueInvite(token, orgId)
      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('forbidden')
    }

    const anonymous = await request(app)
      .post(invitationsPath(orgId))
      .send({ email: 'someone@example.test' })
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')
  })

  it('rejects bad emails, unknown fields, and malformed organization ids', async () => {
    const token = await tokenFor(adminEmail)
    const orgId = await orgIdFor(adminEmail)

    const badEmail = await postInvite(token, orgId, { email: 'not-an-email' })
    expect(badEmail.status).toBe(400)
    expect(badEmail.body.error.code).toBe('validation_error')

    const unknown = await postInvite(token, orgId, {
      email: 'someone@example.test',
      token: 'injected',
    })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.code).toBe('validation_error')

    const missingEmail = await postInvite(token, orgId, {})
    expect(missingEmail.status).toBe(400)
    expect(missingEmail.body.error.code).toBe('validation_error')

    const malformedOrg = await postInvite(token, 'not-a-uuid', { email: 'someone@example.test' })
    expect(malformedOrg.status).toBe(404)
    expect(malformedOrg.body.error.code).toBe('not_found')
  })

  it('refuses a second pending invitation for the same email with 409', async () => {
    const token = await tokenFor(adminEmail)
    const orgId = await orgIdFor(adminEmail)

    const first = await issueInvite(token, orgId, 'person@example.test')
    expect(first.status).toBe(201)

    const duplicate = await issueInvite(token, orgId, 'person@example.test')
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.error.code).toBe('conflict')

    const cased = await issueInvite(token, orgId, 'PERSON@example.test')
    expect(cased.status).toBe(409)
    expect(cased.body.error.code).toBe('conflict')
  })

  it('treats cross-organization issues as missing, never forbidden', async () => {
    const adminToken = await tokenFor(adminEmail)
    const orgId = await orgIdFor(adminEmail)
    const shadowToken = await tokenFor(shadowEmail)

    const crossOrg = await issueInvite(shadowToken, orgId, 'intruder@example.test')
    expect(crossOrg.status).toBe(404)
    expect(crossOrg.body.error.code).toBe('not_found')
    expect(await ownerDatabase.invitation.count({ where: { organizationId: orgId } })).toBe(0)
    expect(adminToken).toBeTruthy()
  })
})

describe('DELETE /api/v1/organizations/:orgId/invitations/:invitationId', () => {
  it('hard-deletes a pending invitation and answers only safe fields', async () => {
    const token = await tokenFor(adminEmail)
    const orgId = await orgIdFor(adminEmail)
    const created = await issueInvite(token, orgId, 'revoke.me@example.test')
    const invitationId = created.body.invitation.id

    const response = await deleteInvite(token, orgId, invitationId)

    expect(response.status).toBe(200)
    expect(Object.keys(response.body.invitation).sort()).toEqual(
      ['acceptedAt', 'createdAt', 'email', 'expiresAt', 'id', 'organizationId', 'updatedAt'].sort(),
    )
    expect(await ownerDatabase.invitation.findFirst({ where: { id: invitationId } })).toBeNull()

    const second = await deleteInvite(token, orgId, invitationId)
    expect(second.status).toBe(404)
    expect(second.body.error.code).toBe('not_found')
  })

  it('answers an unknown invitation with 404 and a malformed id with 400', async () => {
    const token = await tokenFor(adminEmail)
    const orgId = await orgIdFor(adminEmail)

    const missing = await deleteInvite(token, orgId, crypto.randomUUID())
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')

    const malformed = await deleteInvite(token, orgId, 'not-a-uuid')
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.code).toBe('validation_error')
  })

  it('answers an accepted invitation with 409 and the accepted message', async () => {
    const token = await tokenFor(adminEmail)
    const orgId = await orgIdFor(adminEmail)
    const accepted = await ownerDatabase.invitation.create({
      data: {
        organizationId: orgId,
        email: 'taken@example.test',
        tokenHash: sha256('already-accepted-token'),
        expiresAt: new Date(Date.now() + HOUR_MS),
        acceptedAt: new Date(),
      },
    })

    const response = await deleteInvite(token, orgId, accepted.id)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('conflict')
    expect(response.body.error.message).toBe('This invitation has already been accepted')
    expect(
      await ownerDatabase.invitation.findFirst({ where: { id: accepted.id } }),
    ).not.toBeNull()
  })

  it('refuses revokes without the invite capability', async () => {
    const adminToken = await tokenFor(adminEmail)
    const orgId = await orgIdFor(adminEmail)
    const created = await issueInvite(adminToken, orgId, 'someone@example.test')
    const invitationId = created.body.invitation.id

    for (const email of [dispatcherEmail, agentEmail]) {
      const token = await tokenFor(email)
      const response = await deleteInvite(token, orgId, invitationId)
      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('forbidden')
    }

    const anonymous = await request(app).delete(invitationsPath(orgId, invitationId))
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')

    // Still pending: the refusals changed nothing.
    expect(
      await ownerDatabase.invitation.findFirst({ where: { id: invitationId } }),
    ).not.toBeNull()
  })

  it('treats cross-organization revokes as missing, never forbidden', async () => {
    const adminToken = await tokenFor(adminEmail)
    const orgId = await orgIdFor(adminEmail)
    const created = await issueInvite(adminToken, orgId, 'victim@example.test')
    const invitationId = created.body.invitation.id
    const shadowToken = await tokenFor(shadowEmail)

    const response = await deleteInvite(shadowToken, orgId, invitationId)

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
    expect(
      await ownerDatabase.invitation.findFirst({ where: { id: invitationId } }),
    ).not.toBeNull()
  })
})
