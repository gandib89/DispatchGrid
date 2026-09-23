import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { UnrecoverableError } from 'bullmq'
import { handleInviteDelivery } from '../../worker/handlers/invite-delivery.js'
import { routeQueueJob } from '../../worker/handlers/index.js'
import {
  createIdentityFixture,
  createOwnerTestClient,
  resetDatabase,
} from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

const HOUR_MS = 60 * 60 * 1000

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
})

afterAll(async () => {
  await ownerDatabase.$disconnect()
})

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function invitePayload(overrides = {}) {
  return {
    type: 'invite-delivery',
    invitationId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    email: 'invitee@example.test',
    token: 'plaintext-token-value',
    expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    requestId: `req-${crypto.randomUUID()}`,
    ...overrides,
  }
}

function explodingDatabase() {
  return {
    invitation: {
      findFirst() {
        throw new Error('database must not be touched before payload validation')
      },
    },
  }
}

function recordingLogger() {
  const entries = []
  const log = {
    entries,
    child(context) {
      entries.push({ childContext: context })
      return log
    },
    info(context, message) {
      entries.push({ context, message })
    },
  }
  return log
}

async function createInvitationRow(overrides = {}) {
  const fixture = overrides.fixture ?? (await createIdentityFixture(ownerDatabase))
  const invitation = await ownerDatabase.invitation.create({
    data: {
      organizationId: fixture.organization.id,
      email: 'pending@example.test',
      tokenHash: sha256('row-token'),
      expiresAt: new Date(Date.now() + HOUR_MS),
      ...(overrides.data ?? {}),
    },
  })
  return { fixture, invitation }
}

describe('invite-delivery handler entry validation', () => {
  it('rejects a malformed payload before any database code runs', async () => {
    await expect(
      handleInviteDelivery(
        { ...invitePayload(), invitationId: 'not-a-uuid' },
        { prisma: explodingDatabase() },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError)

    await expect(
      handleInviteDelivery({ ...invitePayload(), token: undefined }, { prisma: explodingDatabase() }),
    ).rejects.toBeInstanceOf(UnrecoverableError)

    await expect(
      handleInviteDelivery({ ...invitePayload(), email: 'nope' }, { prisma: explodingDatabase() }),
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })
})

describe('invite-delivery handler', () => {
  it('acknowledges a pending invitation with the originating requestId', async () => {
    const { fixture, invitation } = await createInvitationRow()
    const log = recordingLogger()
    const payload = invitePayload({
      invitationId: invitation.id,
      organizationId: fixture.organization.id,
      requestId: 'req-invite-correlation-1',
    })

    const result = await handleInviteDelivery(payload, { prisma: ownerDatabase, log })

    expect(result).toMatchObject({
      status: 'invite-delivery-ack',
      invitationId: invitation.id,
      requestId: 'req-invite-correlation-1',
    })
    expect(
      log.entries.some((entry) => entry.childContext?.requestId === 'req-invite-correlation-1'),
    ).toBe(true)
    expect(
      log.entries.some(
        (entry) =>
          entry.message === 'Invite delivery acknowledged' ||
          entry.context === 'Invite delivery acknowledged',
      ),
    ).toBe(true)
  })

  it('tolerates a missing invitation as a safe no-op, not a retry', async () => {
    const log = recordingLogger()

    const result = await handleInviteDelivery(invitePayload(), {
      prisma: ownerDatabase,
      log,
    })

    expect(result).toMatchObject({ status: 'invite-missing-noop' })
  })

  it('treats a foreign organizationId as a missing no-op with zero writes', async () => {
    const { invitation } = await createInvitationRow()
    const log = recordingLogger()

    const result = await handleInviteDelivery(
      invitePayload({ invitationId: invitation.id, organizationId: crypto.randomUUID() }),
      { prisma: ownerDatabase, log },
    )

    expect(result).toMatchObject({
      status: 'invite-missing-noop',
      invitationId: invitation.id,
    })
    expect(
      await ownerDatabase.invitation.findFirst({ where: { id: invitation.id } }),
    ).not.toBeNull()
  })

  it('acknowledges an already-accepted invitation as a no-op', async () => {
    const { fixture, invitation } = await createInvitationRow({
      data: { acceptedAt: new Date() },
    })
    const log = recordingLogger()

    const result = await handleInviteDelivery(
      invitePayload({ invitationId: invitation.id, organizationId: fixture.organization.id }),
      { prisma: ownerDatabase, log },
    )

    expect(result).toMatchObject({ status: 'invite-accepted-noop', invitationId: invitation.id })
  })

  it('tolerates a revoked (deleted) invitation as a missing no-op', async () => {
    const { fixture, invitation } = await createInvitationRow()
    await ownerDatabase.invitation.delete({ where: { id: invitation.id } })
    const log = recordingLogger()

    const result = await handleInviteDelivery(
      invitePayload({ invitationId: invitation.id, organizationId: fixture.organization.id }),
      { prisma: ownerDatabase, log },
    )

    expect(result).toMatchObject({ status: 'invite-missing-noop' })
  })
})

describe('handler router dispatch', () => {
  it('routes invite-delivery payloads to the invite handler', async () => {
    const { fixture, invitation } = await createInvitationRow()
    const payload = invitePayload({
      invitationId: invitation.id,
      organizationId: fixture.organization.id,
      requestId: 'req-router-invite-1',
    })

    const result = await routeQueueJob(
      { data: payload },
      { prisma: ownerDatabase, log: recordingLogger() },
    )

    expect(result).toMatchObject({
      status: 'invite-delivery-ack',
      invitationId: invitation.id,
      requestId: 'req-router-invite-1',
    })
  })

  it('fails malformed invite-delivery payloads at the router without retry', async () => {
    await expect(
      routeQueueJob(
        { data: { ...invitePayload(), token: undefined } },
        { prisma: explodingDatabase() },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })
})
