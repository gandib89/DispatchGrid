import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import {
  createOwnerTestClient,
  createRoleFixture,
  createUserFixture,
  resetDatabase,
} from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

const adminEmail = 'admin@dispatchgrid.local'
const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const agentEmail = 'agent@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

beforeEach(async () => {
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

function policyPayload(overrides = {}) {
  return {
    name: `Standard ${crypto.randomUUID().slice(0, 8)}`,
    warningMinutesBefore: 30,
    breachMinutesAfter: 15,
    ...overrides,
  }
}

async function createPolicy(token, payload) {
  return request(app)
    .post('/api/v1/sla-policies')
    .set('Authorization', `Bearer ${token}`)
    .send(payload ?? policyPayload())
}

describe('POST /api/v1/sla-policies', () => {
  it('creates a policy with 201 exposing only safe fields', async () => {
    const token = await tokenFor(adminEmail)
    const response = await createPolicy(token)

    expect(response.status).toBe(201)
    expect(Object.keys(response.body.policy).sort()).toEqual(
      [
        'breachMinutesAfter',
        'createdAt',
        'id',
        'name',
        'organizationId',
        'updatedAt',
        'warningMinutesBefore',
      ].sort(),
    )
    expect(response.body.policy).toMatchObject({
      warningMinutesBefore: 30,
      breachMinutesAfter: 15,
    })
    expect(typeof response.body.policy.createdAt).toBe('string')
  })

  it('accepts zero thresholds (breach exactly at dueAt)', async () => {
    const token = await tokenFor(adminEmail)
    const response = await createPolicy(
      token,
      policyPayload({ warningMinutesBefore: 0, breachMinutesAfter: 0 }),
    )

    expect(response.status).toBe(201)
    expect(response.body.policy).toMatchObject({
      warningMinutesBefore: 0,
      breachMinutesAfter: 0,
    })
  })

  it('refuses writes without the SLA management capability', async () => {
    for (const email of [dispatcherEmail, agentEmail]) {
      const token = await tokenFor(email)
      const response = await createPolicy(token)

      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('forbidden')
    }

    const anonymous = await request(app)
      .post('/api/v1/sla-policies')
      .send(policyPayload())
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')
  })

  it('rejects unknown fields and negative thresholds', async () => {
    const token = await tokenFor(adminEmail)

    const unknown = await createPolicy(token, { ...policyPayload(), injected: true })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.code).toBe('validation_error')

    const negativeWarning = await createPolicy(
      token,
      policyPayload({ warningMinutesBefore: -1 }),
    )
    expect(negativeWarning.status).toBe(400)
    expect(negativeWarning.body.error.code).toBe('validation_error')

    const negativeBreach = await createPolicy(
      token,
      policyPayload({ breachMinutesAfter: -5 }),
    )
    expect(negativeBreach.status).toBe(400)
    expect(negativeBreach.body.error.code).toBe('validation_error')
  })

  it('rejects a duplicate name inside one organization with 409', async () => {
    const token = await tokenFor(adminEmail)
    const payload = policyPayload({ name: 'Standard' })

    const first = await createPolicy(token, payload)
    expect(first.status).toBe(201)

    const second = await createPolicy(token, payload)
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('conflict')
  })
})

describe('GET /api/v1/sla-policies', () => {
  it('lists tenant-scoped policies visible to dispatchers and agents', async () => {
    const adminToken = await tokenFor(adminEmail)
    await createPolicy(adminToken, policyPayload({ name: 'Standard' }))
    await createPolicy(adminToken, policyPayload({ name: 'Express' }))

    for (const email of [dispatcherEmail, agentEmail]) {
      const token = await tokenFor(email)
      const response = await request(app)
        .get('/api/v1/sla-policies')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.policies).toHaveLength(2)
      expect(response.body.policies.map((policy) => policy.name).sort()).toEqual([
        'Express',
        'Standard',
      ])
    }
  })

  it('isolates tenants on the list', async () => {
    const adminToken = await tokenFor(adminEmail)
    await createPolicy(adminToken)

    const shadowToken = await tokenFor(shadowEmail)
    const response = await request(app)
      .get('/api/v1/sla-policies')
      .set('Authorization', `Bearer ${shadowToken}`)

    expect(response.status).toBe(200)
    expect(response.body.policies).toEqual([])
  })
})

describe('GET /api/v1/sla-policies/:id', () => {
  it('returns 404 for cross-organization lookups, never 403', async () => {
    const adminToken = await tokenFor(adminEmail)
    const created = await createPolicy(adminToken)

    const shadowToken = await tokenFor(shadowEmail)
    const crossOrg = await request(app)
      .get(`/api/v1/sla-policies/${created.body.policy.id}`)
      .set('Authorization', `Bearer ${shadowToken}`)
    expect(crossOrg.status).toBe(404)
    expect(crossOrg.body.error.code).toBe('not_found')

    const missing = await request(app)
      .get(`/api/v1/sla-policies/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')

    const malformed = await request(app)
      .get('/api/v1/sla-policies/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.code).toBe('validation_error')
  })
})

describe('PATCH /api/v1/sla-policies/:id', () => {
  it('updates thresholds and refuses writers without the capability', async () => {
    const adminToken = await tokenFor(adminEmail)
    const created = await createPolicy(adminToken)

    const updated = await request(app)
      .patch(`/api/v1/sla-policies/${created.body.policy.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ warningMinutesBefore: 10, breachMinutesAfter: 5 })
    expect(updated.status).toBe(200)
    expect(updated.body.policy).toMatchObject({
      warningMinutesBefore: 10,
      breachMinutesAfter: 5,
    })

    for (const email of [dispatcherEmail, agentEmail]) {
      const token = await tokenFor(email)
      const forbiddenResponse = await request(app)
        .patch(`/api/v1/sla-policies/${created.body.policy.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ warningMinutesBefore: 99 })
      expect(forbiddenResponse.status).toBe(403)
      expect(forbiddenResponse.body.error.code).toBe('forbidden')
    }
  })

  it('treats cross-organization updates as missing', async () => {
    const adminToken = await tokenFor(adminEmail)
    const created = await createPolicy(adminToken)

    // Same-capability caller in another organization: holds sla.manage, so the
    // scoped lookup decides — and it must read as missing, never forbidden.
    const shadowOrg = await ownerDatabase.organization.findFirstOrThrow({
      where: { slug: 'dispatchgrid-shadow' },
    })
    const shadowAdmin = await createUserFixture(ownerDatabase)
    const shadowRole = await createRoleFixture(ownerDatabase, shadowOrg.id)
    const slaManage = await ownerDatabase.permission.findUniqueOrThrow({
      where: { code: 'sla.manage' },
    })
    await ownerDatabase.rolePermission.create({
      data: {
        organizationId: shadowOrg.id,
        roleId: shadowRole.id,
        permissionId: slaManage.id,
      },
    })
    await ownerDatabase.membership.create({
      data: {
        organizationId: shadowOrg.id,
        userId: shadowAdmin.id,
        roleId: shadowRole.id,
      },
    })
    const crossOrg = await request(app)
      .patch(`/api/v1/sla-policies/${created.body.policy.id}`)
      .set('Authorization', `Bearer ${signAccessToken(shadowAdmin.id)}`)
      .send({ warningMinutesBefore: 10 })
    expect(crossOrg.status).toBe(404)
    expect(crossOrg.body.error.code).toBe('not_found')

    const missing = await request(app)
      .patch(`/api/v1/sla-policies/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ warningMinutesBefore: 10 })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')
  })

  it('rejects empty, unknown, negative, and duplicate-name updates', async () => {
    const adminToken = await tokenFor(adminEmail)
    const first = await createPolicy(adminToken, policyPayload({ name: 'Standard' }))
    const second = await createPolicy(adminToken, policyPayload({ name: 'Express' }))
    const patch = (id, body) =>
      request(app)
        .patch(`/api/v1/sla-policies/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body)

    const empty = await patch(first.body.policy.id, {})
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe('validation_error')

    const unknown = await patch(first.body.policy.id, { injected: true })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.code).toBe('validation_error')

    const negative = await patch(first.body.policy.id, { breachMinutesAfter: -1 })
    expect(negative.status).toBe(400)
    expect(negative.body.error.code).toBe('validation_error')

    const duplicate = await patch(second.body.policy.id, { name: 'Standard' })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.error.code).toBe('conflict')
  })
})
