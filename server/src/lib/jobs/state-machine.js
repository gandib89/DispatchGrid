// Pure job lifecycle rules. No Express, Prisma, Redis, or Gemini imports.
// DG-1 (decisions.md): FAILED is retained as a real terminal state reachable
// only from IN_PROGRESS via POST /jobs/:id/fail.

export const JOB_STATUSES = Object.freeze([
  'PENDING',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
])

const BASE_TRANSITIONS = Object.freeze({
  PENDING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['ACCEPTED', 'PENDING', 'ASSIGNED', 'CANCELLED'],
  ACCEPTED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
})

export function allowedNextStates(status) {
  return [...(BASE_TRANSITIONS[status] || [])]
}

export function canTransition(from, to) {
  if (!BASE_TRANSITIONS[from]) return false
  return BASE_TRANSITIONS[from].includes(to)
}

export function assertTransition(from, to) {
  if (canTransition(from, to)) return
  const next = allowedNextStates(from)
  const hint =
    next.length === 0
      ? `${from} is terminal and has no outgoing transitions`
      : `${from} can only move to ${next.join(', ')}`
  throw new Error(`Invalid job transition ${from} → ${to}: ${hint}`)
}
