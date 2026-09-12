import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOwnerTestClient,
  resetDatabase,
} from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
})

afterAll(async () => {
  await ownerDatabase.$disconnect()
})

async function createOrg(slug) {
  return ownerDatabase.organization.create({
    data: { name: `Notify Org ${slug}`, slug, defaultConcurrentJobCap: 3 },
  })
}

async function createUser(email) {
  return ownerDatabase.user.create({
    data: { email, displayName: email, passwordHash: 'test-only-password-hash' },
  })
}

async function createJobRow(organizationId, createdById) {
  return ownerDatabase.job.create({
    data: {
      organizationId,
      reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
      title: 'Fix basement pump',
      latitude: 51.5,
      longitude: -0.12,
      createdById,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  })
}

function notificationData(organizationId, jobId, recipientId, overrides = {}) {
  return {
    organizationId,
    jobId,
    type: 'JOB_ASSIGNED',
    recipientId,
    ...overrides,
  }
}

describe('Notification delivery uniqueness', () => {
  it('rejects a second record for the same job, type, and recipient', async () => {
    const org = await createOrg('notify-dup')
    const user = await createUser('dup@example.test')
    const job = await createJobRow(org.id, user.id)

    await ownerDatabase.notification.create({
      data: notificationData(org.id, job.id, user.id),
    })
    await expect(
      ownerDatabase.notification.create({
        data: notificationData(org.id, job.id, user.id),
      }),
    ).rejects.toThrow()
  })

  it('allows the same job with a different type or recipient', async () => {
    const org = await createOrg('notify-distinct')
    const agent = await createUser('agent@example.test')
    const dispatcher = await createUser('dispatcher@example.test')
    const job = await createJobRow(org.id, dispatcher.id)

    await ownerDatabase.notification.create({
      data: notificationData(org.id, job.id, agent.id),
    })
    await expect(
      ownerDatabase.notification.create({
        data: notificationData(org.id, job.id, agent.id, { type: 'JOB_COMPLETED' }),
      }),
    ).resolves.toBeDefined()
    await expect(
      ownerDatabase.notification.create({
        data: notificationData(org.id, job.id, dispatcher.id),
      }),
    ).resolves.toBeDefined()
  })

  it('starts pending with zero attempts and no timestamps', async () => {
    const org = await createOrg('notify-defaults')
    const user = await createUser('defaults@example.test')
    const job = await createJobRow(org.id, user.id)

    const row = await ownerDatabase.notification.create({
      data: notificationData(org.id, job.id, user.id),
    })

    expect(row).toMatchObject({ status: 'PENDING', attempts: 0 })
    expect(row.lastAttemptAt).toBeNull()
    expect(row.sentAt).toBeNull()
  })
})
