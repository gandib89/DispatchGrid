import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getOrganizationScopedModelNames } from '../../db/tenant-extension.js'
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

function invitationData(organizationId, overrides = {}) {
  return {
    organizationId,
    email: `invitee-${crypto.randomUUID().slice(0, 8)}@example.test`,
    tokenHash: sha256(crypto.randomUUID()),
    expiresAt: new Date(Date.now() + 72 * HOUR_MS),
    ...overrides,
  }
}

describe('Invitation pending uniqueness (partial unique index)', () => {
  it('rejects a second pending invitation for the same organization and email', async () => {
    const { organization } = await createIdentityFixture(ownerDatabase)
    const email = 'person@example.test'

    await expect(
      ownerDatabase.invitation.create({ data: invitationData(organization.id, { email }) }),
    ).resolves.toBeDefined()
    await expect(
      ownerDatabase.invitation.create({ data: invitationData(organization.id, { email }) }),
    ).rejects.toThrow()
  })

  it('matches the pending duplicate case-insensitively via CITEXT', async () => {
    const { organization } = await createIdentityFixture(ownerDatabase)

    await expect(
      ownerDatabase.invitation.create({
        data: invitationData(organization.id, { email: 'Person@Example.TEST' }),
      }),
    ).resolves.toBeDefined()
    await expect(
      ownerDatabase.invitation.create({
        data: invitationData(organization.id, { email: 'person@example.test' }),
      }),
    ).rejects.toThrow()
  })

  it('allows the same email pending in two organizations', async () => {
    const first = await createIdentityFixture(ownerDatabase)
    const second = await createIdentityFixture(ownerDatabase)
    const email = 'shared@example.test'

    await expect(
      ownerDatabase.invitation.create({ data: invitationData(first.organization.id, { email }) }),
    ).resolves.toBeDefined()
    await expect(
      ownerDatabase.invitation.create({ data: invitationData(second.organization.id, { email }) }),
    ).resolves.toBeDefined()
  })

  it('lets an accepted invitation leave the index so a re-invite can pending again', async () => {
    const { organization } = await createIdentityFixture(ownerDatabase)
    const email = 'returning@example.test'
    await ownerDatabase.invitation.create({
      data: invitationData(organization.id, { email, acceptedAt: new Date() }),
    })

    await expect(
      ownerDatabase.invitation.create({ data: invitationData(organization.id, { email }) }),
    ).resolves.toBeDefined()
    await expect(
      ownerDatabase.invitation.create({ data: invitationData(organization.id, { email }) }),
    ).rejects.toThrow()
  })
})

describe('Invitation token hash uniqueness', () => {
  it('rejects a duplicate token hash across organizations and emails', async () => {
    const first = await createIdentityFixture(ownerDatabase)
    const second = await createIdentityFixture(ownerDatabase)
    const tokenHash = sha256('shared-token')

    await expect(
      ownerDatabase.invitation.create({
        data: invitationData(first.organization.id, { tokenHash }),
      }),
    ).resolves.toBeDefined()
    await expect(
      ownerDatabase.invitation.create({
        data: invitationData(second.organization.id, { tokenHash }),
      }),
    ).rejects.toThrow()
  })
})

describe('Invitation tenant scoping', () => {
  it('picks up Invitation in the derived scoped-model list', () => {
    expect(getOrganizationScopedModelNames().has('Invitation')).toBe(true)
  })

  it('starts every Invitation composite tenant index with organizationId', async () => {
    const rows = await ownerDatabase.$queryRaw`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'Invitation'
        AND indexdef ILIKE '%organizationId%'
    `

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const columns = row.indexdef.match(/\(([^)]+)\)/)[1]
      expect(columns.split(',')[0].trim().replaceAll('"', '')).toBe('organizationId')
    }
  })

  it('declares the pending index as partial over acceptedAt', async () => {
    const rows = await ownerDatabase.$queryRaw`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'Invitation_organizationId_email_pending_key'
    `

    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/WHERE \("acceptedAt" IS NULL\)$/)
  })
})
