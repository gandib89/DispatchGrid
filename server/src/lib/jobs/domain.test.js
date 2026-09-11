import { describe, expect, it } from 'vitest'
import { allowedNextStates, assertTransition, canTransition } from './state-machine.js'
import { checkAgentEligibility } from './eligibility.js'
import { haversineKm, rankAgents } from './suggestion-scoring.js'

describe('job state machine', () => {
  it('allows every legal transition, including retained FAILED', () => {
    const legal = [
      ['PENDING', 'ASSIGNED'],
      ['ASSIGNED', 'ACCEPTED'],
      ['ASSIGNED', 'PENDING'],
      ['ASSIGNED', 'ASSIGNED'],
      ['ACCEPTED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'COMPLETED'],
      ['IN_PROGRESS', 'FAILED'],
      ['PENDING', 'CANCELLED'],
      ['ASSIGNED', 'CANCELLED'],
      ['ACCEPTED', 'CANCELLED'],
      ['IN_PROGRESS', 'CANCELLED'],
    ]
    for (const [from, to] of legal) {
      expect(canTransition(from, to)).toBe(true)
      expect(() => assertTransition(from, to)).not.toThrow()
    }
  })

  it('rejects illegal moves and terminal exits', () => {
    expect(canTransition('PENDING', 'COMPLETED')).toBe(false)
    expect(canTransition('COMPLETED', 'PENDING')).toBe(false)
    expect(canTransition('CANCELLED', 'ASSIGNED')).toBe(false)
    expect(canTransition('FAILED', 'PENDING')).toBe(false)
    expect(canTransition('ACCEPTED', 'ASSIGNED')).toBe(false)
    expect(() => assertTransition('PENDING', 'COMPLETED')).toThrow(/Invalid job transition/)
    expect(allowedNextStates('COMPLETED')).toEqual([])
    expect(allowedNextStates('CANCELLED')).toEqual([])
    expect(allowedNextStates('FAILED')).toEqual([])
  })

  it('reaches CANCELLED from every non-terminal state', () => {
    for (const status of ['PENDING', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS']) {
      expect(canTransition(status, 'CANCELLED')).toBe(true)
    }
  })
})

describe('agent eligibility', () => {
  const baseMembership = {
    organizationId: 'org-1',
    role: { name: 'AGENT' },
    isAvailable: true,
    concurrentJobCap: null,
  }

  it('accepts an eligible agent under the default cap', () => {
    const result = checkAgentEligibility({
      membership: baseMembership,
      organizationId: 'org-1',
      activeJobCount: 1,
      defaultCap: 3,
    })
    expect(result).toMatchObject({ eligible: true, reasons: [], effectiveCap: 3 })
  })

  it('rejects wrong org, wrong role, unavailable, and exact cap', () => {
    expect(
      checkAgentEligibility({
        membership: { ...baseMembership, organizationId: 'org-2' },
        organizationId: 'org-1',
        activeJobCount: 0,
        defaultCap: 3,
      }).reasons,
    ).toContain('wrong_organization')

    expect(
      checkAgentEligibility({
        membership: { ...baseMembership, role: { name: 'DISPATCHER' } },
        organizationId: 'org-1',
        activeJobCount: 0,
        defaultCap: 3,
      }).reasons,
    ).toContain('wrong_role')

    expect(
      checkAgentEligibility({
        membership: { ...baseMembership, isAvailable: false },
        organizationId: 'org-1',
        activeJobCount: 0,
        defaultCap: 3,
      }).reasons,
    ).toContain('unavailable')

    const atCap = checkAgentEligibility({
      membership: baseMembership,
      organizationId: 'org-1',
      activeJobCount: 3,
      defaultCap: 3,
    })
    expect(atCap.eligible).toBe(false)
    expect(atCap.reasons).toContain('at_cap')
  })

  it('prefers the membership cap override over the org default', () => {
    const override = checkAgentEligibility({
      membership: { ...baseMembership, concurrentJobCap: 1 },
      organizationId: 'org-1',
      activeJobCount: 1,
      defaultCap: 5,
    })
    expect(override.effectiveCap).toBe(1)
    expect(override.eligible).toBe(false)
  })
})

describe('suggestion scoring', () => {
  const jobLocation = { latitude: 51.5, longitude: -0.12 }

  it('returns an empty ranking when there are no candidates', () => {
    expect(rankAgents([], jobLocation)).toEqual([])
  })

  it('ranks nearer, less-loaded agents first with a stable tie-break', () => {
    const candidates = [
      { userId: 'user-b', agentId: 'user-b', location: { latitude: 52.5, longitude: -0.12 }, activeJobs: 0 },
      { userId: 'user-a', agentId: 'user-a', location: jobLocation, activeJobs: 2 },
      { userId: 'user-c', agentId: 'user-c', location: jobLocation, activeJobs: 0 },
    ]
    const ranked = rankAgents(candidates, jobLocation)
    expect(ranked[0].userId).toBe('user-c')
    expect(ranked.map((item) => item.userId)).toEqual(['user-c', 'user-a', 'user-b'])
    expect(ranked[0]).toHaveProperty('distanceKm')
    expect(ranked[0]).toHaveProperty('finalScore')
  })

  it('breaks exact ties by userId for byte-equivalent ordering', () => {
    const candidates = [
      { userId: 'user-b', location: jobLocation, activeJobs: 0 },
      { userId: 'user-a', location: jobLocation, activeJobs: 0 },
    ]
    const first = rankAgents(candidates, jobLocation)
    const second = rankAgents([...candidates].reverse(), jobLocation)
    expect(first.map((item) => item.userId)).toEqual(['user-a', 'user-b'])
    expect(second.map((item) => item.userId)).toEqual(['user-a', 'user-b'])
  })

  it('handles identical coordinates and antimeridian crossings', () => {
    expect(haversineKm(jobLocation, jobLocation)).toBe(0)
    const across = haversineKm(
      { latitude: 0, longitude: 179.9 },
      { latitude: 0, longitude: -179.9 },
    )
    expect(across).toBeGreaterThan(0)
    expect(across).toBeLessThan(50)
  })
})
