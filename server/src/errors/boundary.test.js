import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { organizationSchemas } from '../../../shared/organization-schema.js'
import { jobSchemas } from '../../../shared/job-schema.js'
import { errorEnvelope, HttpError, versionConflict } from '../errors/http-errors.js'
import { serializeJob } from '../serializers/job-serializer.js'
import { serializeOrganization } from '../serializers/organization-serializer.js'

const orgSchemas = organizationSchemas(z)
const job = jobSchemas(z)

describe('shared schema boundaries', () => {
  it('rejects unknown fields instead of silently accepting them', () => {
    expect(() =>
      orgSchemas.createOrganizationSchema.parse({ name: 'Acme', unknown: true }),
    ).toThrow()
    expect(() =>
      job.createJobSchema.parse({
        title: 'Fix pump',
        latitude: 51.5,
        longitude: -0.12,
        dueAt: new Date(Date.now() + 3600_000).toISOString(),
        injected: 'nope',
      }),
    ).toThrow()
  })

  it('rejects out-of-range coordinates and bad versions', () => {
    expect(() =>
      job.createJobSchema.parse({
        title: 'Fix pump',
        latitude: 91,
        longitude: 0,
        dueAt: new Date().toISOString(),
      }),
    ).toThrow()
    expect(() => job.assignJobSchema.parse({ agentId: crypto.randomUUID() })).toThrow()
  })

  it('caps board page size at 100', () => {
    expect(() => job.jobQuerySchema.parse({ pageSize: 101 })).toThrow()
  })
})

describe('error envelope', () => {
  it('lets clients branch on error.code, not message text', () => {
    const error = versionConflict('Stale version')
    const envelope = errorEnvelope(error)
    expect(envelope).toEqual({
      error: { code: 'version_conflict', message: 'Stale version' },
    })
    expect(error).toBeInstanceOf(HttpError)
  })
})

describe('serializers', () => {
  it('serializes dates to ISO strings and drops internal fields', () => {
    const now = new Date('2026-09-01T10:00:00.000Z')
    const serialized = serializeJob({
      id: 'job-id',
      organizationId: 'org-id',
      reference: 'JOB-2026-000001',
      title: 'Fix pump',
      description: 'Basement pump',
      address: '1 Main St',
      latitude: 51.5,
      longitude: -0.12,
      priority: 'HIGH',
      status: 'PENDING',
      slaState: 'OK',
      currentAssigneeId: null,
      createdById: 'user-id',
      version: 1,
      dueAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      passwordHash: 'must-never-leak',
    })

    expect(serialized.dueAt).toBe('2026-09-01T10:00:00.000Z')
    expect(serialized).not.toHaveProperty('passwordHash')
    expect(serialized.reference).toBe('JOB-2026-000001')
  })

  it('serializes organizations without leaking membership internals', () => {
    const now = new Date('2026-09-01T10:00:00.000Z')
    const serialized = serializeOrganization({
      id: 'org-id',
      name: 'Acme',
      slug: 'acme-abc123',
      defaultConcurrentJobCap: 3,
      createdAt: now,
      updatedAt: now,
      passwordHash: 'must-never-leak',
    })
    expect(serialized.createdAt).toBe('2026-09-01T10:00:00.000Z')
    expect(serialized).not.toHaveProperty('passwordHash')
  })
})
