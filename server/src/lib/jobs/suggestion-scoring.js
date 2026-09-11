// Deterministic agent ranking. No Express, Prisma, Redis, or Gemini imports.
// Eligibility filtering happens before scoring: ineligible agents are absent,
// never low-scored. Equal scores always sort by userId so output is stable.

const EARTH_RADIUS_KM = 6371

function toRadians(degrees) {
  return (degrees * Math.PI) / 180
}

export function haversineKm(from, to) {
  const dLat = toRadians(to.latitude - from.latitude)
  let dLon = Math.abs(to.longitude - from.longitude)
  if (dLon > 180) dLon = 360 - dLon
  const lon = toRadians(dLon)
  const lat1 = toRadians(from.latitude)
  const lat2 = toRadians(to.latitude)

  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))
}

export function scoreAgent(candidate, jobLocation, weights = {}) {
  const { distanceWeight = 1, loadWeight = 10 } = weights
  const distanceKm = haversineKm(candidate.location, jobLocation)
  const distanceScore = distanceKm * distanceWeight
  const loadScore = candidate.activeJobs * loadWeight
  return {
    agentId: candidate.agentId ?? candidate.userId,
    userId: candidate.userId ?? candidate.agentId,
    distanceKm,
    activeJobs: candidate.activeJobs,
    distanceScore,
    loadScore,
    finalScore: distanceScore + loadScore,
  }
}

export function rankAgents(candidates, jobLocation, weights = {}) {
  const scored = candidates.map((candidate) => scoreAgent(candidate, jobLocation, weights))
  scored.sort((a, b) => {
    if (a.finalScore !== b.finalScore) return a.finalScore - b.finalScore
    return String(a.userId).localeCompare(String(b.userId))
  })
  return scored
}
