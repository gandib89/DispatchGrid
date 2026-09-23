import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { issueInvitation, revokeInvitation } from './invitation-service.js'
import {
  createIdentityFixture,
  createOwnerTestClient,
  resetDatabase,
} from '../test/helpers.js'

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

async function inviteActor(overrides = {}) {
  const fixture = await createIdentityFixture(ownerDatabase)
  return {
    organization: fixture.organization,
    user: fixture.user,
    actor: {
      userId: fixture.user.id,
      organizationId: fixture.organization.id,
      membershipId: fixture.membership.id,
      roleId: fixture.role.id,
      roleName: fixture.role.name,
      permissions: ['org.invite'],
      ...overrides,
    },
  }
}

async function pendingRow(organizationId, email) {
  return ownerDatabase.invitation.findFirst({
    where: { organizationId, email, acceptedAt: null },
  })
}

describe('issueInvitation', () => {
  it('issues a pending invitation storing only the SHA-256 hash for 72h', async () => {
    const { actor, organization } = await inviteActor()
    const before = Date.now()

    const { invitation, token } = await issueInvitation(actor, {
      email: 'New.Member@Example.TEST',
    })

    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThanOrEqual(20)
    expect(invitation).toMatchObject({
      organizationId: organization.id,
      email: 'new.member@example.test',
      tokenHash: sha256(token),
      acceptedAt: null,
    })
    expect(Object.keys(invitation)).not.toContain('token')

    const ttlMs = invitation.expiresAt.getTime() - before
    expect(ttlMs).toBeGreaterThanOrEqual(71 * HOUR_MS)
    expect(ttlMs).toBeLessThanOrEqual(73 * HOUR_MS)

    const row = await pendingRow(organization.id, 'new.member@example.test')
    expect(row).toMatchObject({ tokenHash: invitation.tokenHash })
    expect(Object.keys(row)).not.toContain('token')
  })

  it('issues distinct token hashes for distinct invitations', async () => {
    const { actor } = await inviteActor()

    const first = await issueInvitation(actor, { email: 'one@example.test' })
    const second = await issueInvitation(actor, { email: 'two@example.test' })

    expect(first.token).not.toBe(second.token)
    expect(first.invitation.tokenHash).not.toBe(second.invitation.tokenHash)
    expect(first.invitation.tokenHash).toBe(sha256(first.token))
  })

  it('refuses a second pending invitation for the same email with conflict', async () => {
    const { actor } = await inviteActor()
    await issueInvitation(actor, { email: 'person@example.test' })

    await expect(issueInvitation(actor, { email: 'person@example.test' })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    })
  })

  it('matches the pending duplicate case-insensitively before the index fires', async () => {
    const { actor } = await inviteActor()
    await issueInvitation(actor, { email: 'person@example.test' })

    await expect(issueInvitation(actor, { email: 'PERSON@example.test' })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    })
  })

  it('allows the same email in a different organization', async () => {
    const first = await inviteActor()
    const second = await inviteActor()

    await expect(
      issueInvitation(first.actor, { email: 'shared@example.test' }),
    ).resolves.toBeDefined()
    await expect(
      issueInvitation(second.actor, { email: 'shared@example.test' }),
    ).resolves.toBeDefined()
  })

  it('refuses callers without the invite capability', async () => {
    const { actor } = await inviteActor({ permissions: [] })

    await expect(issueInvitation(actor, { email: 'person@example.test' })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
    expect(await ownerDatabase.invitation.count()).toBe(0)
  })

  it('requires an email', async () => {
    const { actor } = await inviteActor()

    await expect(issueInvitation(actor, { email: '' })).rejects.toMatchObject({
      status: 400,
      code: 'validation_error',
    })
    await expect(issueInvitation(actor, {})).rejects.toMatchObject({
      status: 400,
      code: 'validation_error',
    })
  })

  it('commits with an outer transaction and rolls back with it', async () => {
    const committing = await inviteActor()
    const { invitation } = await ownerDatabase.$transaction(async (tx) =>
      issueInvitation(committing.actor, { email: 'committed@example.test' }, { tx }),
    )
    expect(await pendingRow(committing.organization.id, 'committed@example.test')).toMatchObject({
      id: invitation.id,
    })

    const rolling = await inviteActor()
    await expect(
      ownerDatabase.$transaction(async (tx) => {
        await issueInvitation(rolling.actor, { email: 'rolled-back@example.test' }, { tx })
        throw new Error('outer work failed')
      }),
    ).rejects.toThrow('outer work failed')
    expect(await pendingRow(rolling.organization.id, 'rolled-back@example.test')).toBeNull()
  })
})

describe('revokeInvitation', () => {
  it('hard-deletes a pending invitation', async () => {
    const { actor, organization } = await inviteActor()
    const { invitation } = await issueInvitation(actor, { email: 'person@example.test' })

    const revoked = await revokeInvitation(actor, { invitationId: invitation.id })

    expect(revoked.invitation.id).toBe(invitation.id)
    expect(
      await ownerDatabase.invitation.findFirst({ where: { id: invitation.id } }),
    ).toBeNull()
    expect(await pendingRow(organization.id, 'person@example.test')).toBeNull()
  })

  it('answers an unknown invitation as not found', async () => {
    const { actor } = await inviteActor()

    await expect(
      revokeInvitation(actor, { invitationId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  it('answers a cross-organization invitation as not found, never forbidden', async () => {
    const owner = await inviteActor()
    const { invitation } = await issueInvitation(owner.actor, { email: 'person@example.test' })
    const outsider = await inviteActor()

    await expect(
      revokeInvitation(outsider.actor, { invitationId: invitation.id }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' })
    expect(
      await ownerDatabase.invitation.findFirst({ where: { id: invitation.id } }),
    ).not.toBeNull()
  })

  it('answers an accepted invitation as conflict with the accepted message', async () => {
    const { actor, organization } = await inviteActor()
    const accepted = await ownerDatabase.invitation.create({
      data: {
        organizationId: organization.id,
        email: 'taken@example.test',
        tokenHash: sha256('already-accepted-token'),
        expiresAt: new Date(Date.now() + HOUR_MS),
        acceptedAt: new Date(),
      },
    })

    await expect(
      revokeInvitation(actor, { invitationId: accepted.id }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'This invitation has already been accepted',
    })
    expect(
      await ownerDatabase.invitation.findFirst({ where: { id: accepted.id } }),
    ).not.toBeNull()
  })

  it('lets the pending index accept a re-invite after acceptance', async () => {
    const { actor, organization } = await inviteActor()
    await ownerDatabase.invitation.create({
      data: {
        organizationId: organization.id,
        email: 'returning@example.test',
        tokenHash: sha256('first-token'),
        expiresAt: new Date(Date.now() - HOUR_MS),
        acceptedAt: new Date(),
      },
    })

    const reissued = await issueInvitation(actor, { email: 'returning@example.test' })

    expect(reissued.invitation.acceptedAt).toBeNull()
    expect(await pendingRow(organization.id, 'returning@example.test')).toMatchObject({
      id: reissued.invitation.id,
    })
  })

  it('rejects a missing invitation id', async () => {
    const { actor } = await inviteActor()

    await expect(revokeInvitation(actor, {})).rejects.toMatchObject({
      status: 400,
      code: 'validation_error',
    })
    await expect(
      revokeInvitation(actor, { invitationId: 42 }),
    ).rejects.toMatchObject({ status: 400, code: 'validation_error' })
  })

  it('rolls back the delete when the outer transaction fails', async () => {
    const { actor, organization } = await inviteActor()
    const { invitation } = await issueInvitation(actor, { email: 'person@example.test' })

    await expect(
      ownerDatabase.$transaction(async (tx) => {
        await revokeInvitation(actor, { invitationId: invitation.id }, { tx })
        throw new Error('outer work failed')
      }),
    ).rejects.toThrow('outer work failed')
    expect(
      await ownerDatabase.invitation.findFirst({ where: { id: invitation.id } }),
    ).toMatchObject({ organizationId: organization.id })
  })
})
