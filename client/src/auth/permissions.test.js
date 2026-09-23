import { describe, expect, it } from 'vitest'
import { ROLE_PERMISSIONS, can } from './permissions.js'

describe('can (presentation-only)', () => {
  it('grants ADMIN every seeded permission code', () => {
    const codes = [
      'job.view',
      'job.create',
      'job.update',
      'job.assign',
      'job.respond',
      'job.cancel',
      'org.invite',
      'org.manage',
      'sla.manage',
      'report.view',
    ]
    for (const code of codes) {
      expect(can('ADMIN', code)).toBe(true)
    }
    expect(ROLE_PERMISSIONS.ADMIN).toEqual(codes)
  })

  it('grants DISPATCHER job assignment but not org administration or agent responses', () => {
    expect(can('DISPATCHER', 'job.assign')).toBe(true)
    expect(can('DISPATCHER', 'job.view')).toBe(true)
    expect(can('DISPATCHER', 'report.view')).toBe(true)
    expect(can('DISPATCHER', 'org.manage')).toBe(false)
    expect(can('DISPATCHER', 'job.respond')).toBe(false)
  })

  it('grants AGENT only view and respond', () => {
    expect(can('AGENT', 'job.respond')).toBe(true)
    expect(can('AGENT', 'job.view')).toBe(true)
    expect(can('AGENT', 'job.assign')).toBe(false)
    expect(can('AGENT', 'org.invite')).toBe(false)
  })

  it('denies unknown roles and unknown codes', () => {
    expect(can(null, 'job.view')).toBe(false)
    expect(can(undefined, 'job.view')).toBe(false)
    expect(can('NO_SUCH_ROLE', 'job.view')).toBe(false)
    expect(can('ADMIN', 'no.such.code')).toBe(false)
  })
})
