import { prisma } from '../db/client.js'
import { checkAgentEligibility } from '../lib/jobs/eligibility.js'
import { rankAgents } from '../lib/jobs/suggestion-scoring.js'
import { requirePermission, scopedJob } from './transaction.js'

const ACTIVE_ASSIGNMENT_STATES = ['OFFERED', 'ACCEPTED']

// The positions map is the documented seam where live tracking (B14) plugs in
// later: callers pass known agent coordinates keyed by user id, and this read
// stays unchanged when that source becomes live data.
function lookupPosition(positions, userId) {
  if (positions instanceof Map) {
    return positions.get(userId) ?? null
  }
  return null
}

function validPosition(value) {
  if (!value || typeof value.latitude !== 'number' || typeof value.longitude !== 'number') {
    return null
  }
  if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) {
    return null
  }
  return { latitude: value.latitude, longitude: value.longitude }
}

export async function suggestAgents(actor, jobId, positions = new Map()) {
  requirePermission(actor, 'job.assign')

  const job = await scopedJob(prisma, actor, jobId)
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: actor.organizationId },
  })
  const memberships = await prisma.membership.findMany({
    where: { organizationId: actor.organizationId },
    include: { role: true },
  })
  const grouped = await prisma.assignment.groupBy({
    by: ['agentId'],
    where: {
      organizationId: actor.organizationId,
      state: { in: ACTIVE_ASSIGNMENT_STATES },
    },
    _count: { agentId: true },
  })
  const activeByAgent = new Map(grouped.map((row) => [row.agentId, row._count.agentId]))
  const jobLocation = { latitude: Number(job.latitude), longitude: Number(job.longitude) }

  const known = []
  const unknown = []
  for (const membership of memberships) {
    const activeJobs = activeByAgent.get(membership.userId) ?? 0
    const eligibility = checkAgentEligibility({
      membership,
      organizationId: actor.organizationId,
      activeJobCount: activeJobs,
      defaultCap: organization.defaultConcurrentJobCap,
    })
    if (!eligibility.eligible) {
      continue
    }
    const position = validPosition(lookupPosition(positions, membership.userId))
    const base = { userId: membership.userId, agentId: membership.userId, activeJobs }
    if (position) {
      known.push({ ...base, location: position })
    } else {
      unknown.push(base)
    }
  }

  const rankedKnown = rankAgents(known, jobLocation).map((scored) => ({
    userId: scored.userId,
    agentId: scored.agentId,
    distanceKm: scored.distanceKm,
    activeJobs: scored.activeJobs,
    finalScore: scored.finalScore,
    positionKnown: true,
  }))

  unknown.sort((a, b) => {
    if (a.activeJobs !== b.activeJobs) {
      return a.activeJobs - b.activeJobs
    }
    return String(a.userId).localeCompare(String(b.userId))
  })
  const rankedUnknown = unknown.map((entry) => ({
    userId: entry.userId,
    agentId: entry.agentId,
    distanceKm: null,
    activeJobs: entry.activeJobs,
    finalScore: null,
    positionKnown: false,
  }))

  return [...rankedKnown, ...rankedUnknown]
}
