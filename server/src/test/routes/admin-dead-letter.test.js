import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import {
  QUEUE_NAMES,
  getQueue,
  sendToDeadLetter,
} from '../../lib/queue/index.js'
import {
  createOwnerTestClient,
  resetDatabase,
} from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

const adminEmail = 'admin@dispatchgrid.local'
const dispatcherEmail = 'dispatcher@dispatchgrid.local'

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
  await getQueue(QUEUE_NAMES.deadLetter).obliterate({ force: true })
  await getQueue(QUEUE_NAMES.notifications).obliterate({ force: true })
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})

async function tokenFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  return signAccessToken(user.id)
}

async function organizationIdFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  const membership = await ownerDatabase.membership.findFirstOrThrow({
    where: { userId: user.id },
  })
  return membership.organizationId
}

function failedJob(organizationId, requestId) {
  return {
    id: `bull-${crypto.randomUUID()}`,
    name: 'notification',
    data: {
      type: 'notification',
      jobId: crypto.randomUUID(),
      organizationId,
      requestId,
      notificationType: 'SLA_BREACH',
      recipientId: crypto.randomUUID(),
    },
    attemptsMade: 5,
  }
}

async function plantDeadLetter(organizationId, requestId) {
  return sendToDeadLetter(
    QUEUE_NAMES.notifications,
    failedJob(organizationId, requestId),
    new Error('provider down'),
  )
}

describe('GET /api/v1/admin/dead-letter', () => {
  it('lists exhausted deliveries with request correlation', async () => {
    const token = await tokenFor(adminEmail)
    const organizationId = await organizationIdFor(adminEmail)
    const requestId = `req-dlq-${crypto.randomUUID()}`
    await plantDeadLetter(organizationId, requestId)

    const response = await request(app)
      .get('/api/v1/admin/dead-letter')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.body.deadLetters).toHaveLength(1)
    expect(response.body.deadLetters[0]).toMatchObject({
      sourceQueue: QUEUE_NAMES.notifications,
      requestId,
      organizationId,
      attemptsMade: 5,
      failedReason: 'provider down',
    })
    expect(typeof response.body.deadLetters[0].failedAt).toBe('string')
  })

  it('hides another organization’s failures', async () => {
    const token = await tokenFor(adminEmail)
    await plantDeadLetter(crypto.randomUUID(), `req-foreign-${crypto.randomUUID()}`)

    const response = await request(app)
      .get('/api/v1/admin/dead-letter')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.body.deadLetters).toHaveLength(0)
  })

  it('refuses readers without the organization management capability', async () => {
    const token = await tokenFor(dispatcherEmail)

    const response = await request(app)
      .get('/api/v1/admin/dead-letter')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('forbidden')

    const anonymous = await request(app).get('/api/v1/admin/dead-letter')
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')
  })
})

describe('POST /api/v1/admin/dead-letter/:id/replay', () => {
  it('re-enqueues the payload on its source queue', async () => {
    const token = await tokenFor(adminEmail)
    const organizationId = await organizationIdFor(adminEmail)
    const requestId = `req-replay-${crypto.randomUUID()}`
    const stored = await plantDeadLetter(organizationId, requestId)

    const response = await request(app)
      .post(`/api/v1/admin/dead-letter/${stored.id}/replay`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(202)
    expect(response.body).toMatchObject({ sourceQueue: QUEUE_NAMES.notifications })
    const replayed = await getQueue(QUEUE_NAMES.notifications).getJob(response.body.jobId)
    expect(replayed?.data).toMatchObject({ requestId, organizationId })
  })

  it('returns 404 for unknown or foreign entries', async () => {
    const token = await tokenFor(adminEmail)
    await plantDeadLetter(crypto.randomUUID(), `req-foreign-${crypto.randomUUID()}`)

    const missing = await request(app)
      .post('/api/v1/admin/dead-letter/no-such-id/replay')
      .set('Authorization', `Bearer ${token}`)
    expect(missing.status).toBe(404)

    const foreign = await getQueue(QUEUE_NAMES.deadLetter).getJobs(['waiting'], 0, 10)
    const foreignReplay = await request(app)
      .post(`/api/v1/admin/dead-letter/${foreign[0].id}/replay`)
      .set('Authorization', `Bearer ${token}`)
    expect(foreignReplay.status).toBe(404)
  })

  it('refuses replay without the organization management capability', async () => {
    const adminToken = await tokenFor(adminEmail)
    const organizationId = await organizationIdFor(adminEmail)
    const stored = await plantDeadLetter(organizationId, `req-replay-${crypto.randomUUID()}`)
    const token = await tokenFor(dispatcherEmail)

    const response = await request(app)
      .post(`/api/v1/admin/dead-letter/${stored.id}/replay`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(403)
    expect(adminToken).toBeDefined()
  })
})
