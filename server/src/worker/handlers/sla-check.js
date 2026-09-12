import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { consumeJob } from './consume-job.js'
import { integrationAdapters } from '../../lib/integration-adapters.js'
import { logger } from '../../lib/logger.js'

const schemas = queueSchemas(z)

// Terminal states never escalate (DG-1: FAILED is retained as terminal).
const TERMINAL_JOB_STATUSES = Object.freeze(['COMPLETED', 'CANCELLED', 'FAILED'])

// Pre-B12 (B11) delayed timers carried no threshold promise — just the job
// identity. They fail the strict threshold schema below, so recognize them
// here and acknowledge them as no-ops: the upgrade drains instead of
// poisoning (see docs/decisions.md, B11→B12 upgrade).
const legacySlaCheckPayloadSchema = z.object({
  type: z.literal('sla-check'),
  jobId: z.string().uuid(),
  organizationId: z.string().uuid(),
  requestId: z.string().min(1).max(128),
})

export function isLegacySlaCheck(payload) {
  return (
    payload?.type === 'sla-check' &&
    payload?.threshold === undefined &&
    legacySlaCheckPayloadSchema.safeParse(payload).success
  )
}

function isUniqueViolation(error) {
  return error?.code === 'P2002'
}

// Time-driven evaluation (B12-T4): parse at entry, re-read tenant-scoped
// PostgreSQL state (the frozen payload snapshot is the A-6 promise, not
// truth), no-op on terminal jobs, otherwise update the job SLA state plus
// one durable escalation per threshold in a single transaction. A uniqueness
// conflict is already-complete (acknowledge, never retry); genuine failures
// throw for redelivery. Breach side effects (notification enqueue, realtime
// publish) run only after the commit, never inside the transaction.
export async function handleSlaCheck(payload, deps = {}) {
  if (isLegacySlaCheck(payload)) {
    const log = (deps.log ?? logger).child({
      handler: 'sla-check',
      requestId: payload.requestId,
      jobId: payload.jobId,
      organizationId: payload.organizationId,
    })
    log.info('Pre-B12 sla-check payload without a threshold promise; acknowledging as no-op')
    return { status: 'sla-legacy-noop', jobId: payload.jobId, requestId: payload.requestId }
  }
  return consumeJob(payload, deps, {
    handler: 'sla-check',
    schema: schemas.slaCheckPayloadSchema,
    unprocessablePrefix: 'Unprocessable sla-check payload',
    missingLog: 'sla-check for unknown job; acknowledging as no-op',
    onJobFound: async (job, data, log) => {
      if (TERMINAL_JOB_STATUSES.includes(job.status)) {
        log.info({ jobStatus: job.status, threshold: data.threshold }, 'SLA check on terminal job; acknowledging as no-op')
        return { status: 'sla-terminal-noop', jobId: job.id, requestId: data.requestId, threshold: data.threshold }
      }

      // WARNING never downgrades an already-BREACHED job, but still records
      // its own escalation row; a BREACH without a prior warning converges
      // straight to BREACHED.
      const nextSlaState =
        data.threshold === 'BREACH' ? 'BREACHED' : job.slaState === 'BREACHED' ? 'BREACHED' : 'WARNING'

      const publishBreachSideEffects = async (escalationId) => {
        const publish = deps.publishEscalationEvent ?? integrationAdapters.publishEscalationEvent
        const enqueue = deps.enqueueEscalationNotification ?? integrationAdapters.enqueueEscalationNotification
        await publish({
          jobId: job.id,
          organizationId: job.organizationId,
          escalationId,
          threshold: data.threshold,
          requestId: data.requestId,
        })
        await enqueue({
          jobId: job.id,
          organizationId: job.organizationId,
          requestId: data.requestId,
          threshold: data.threshold,
          escalationId,
        })
      }

      let escalation
      try {
        escalation = await deps.prisma.$transaction(async (tx) => {
          const claimed = await tx.job.updateMany({
            where: { id: job.id, organizationId: job.organizationId },
            data: { slaState: nextSlaState },
          })
          if (claimed.count === 0) {
            throw new Error('SLA job vanished mid-transaction')
          }
          return tx.escalation.create({
            data: { organizationId: job.organizationId, jobId: job.id, threshold: data.threshold },
          })
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          log.info({ threshold: data.threshold }, 'SLA escalation already recorded; acknowledging as complete')
          if (data.threshold === 'BREACH') {
            // Post-commit side effects may have died with the first delivery
            // (the retry lands here via P2002): re-attempt them before acking.
            const existing = await deps.prisma.escalation
              .findFirst({ where: { jobId: job.id, threshold: data.threshold } })
              .catch(() => null)
            await publishBreachSideEffects(existing?.id)
          }
          return {
            status: 'sla-escalation-complete',
            jobId: job.id,
            requestId: data.requestId,
            threshold: data.threshold,
          }
        }
        throw error
      }

      log.info(
        { threshold: data.threshold, slaState: nextSlaState, escalationId: escalation.id },
        'SLA escalation recorded',
      )

      if (data.threshold === 'BREACH') {
        await publishBreachSideEffects(escalation.id)
      }

      return {
        status: 'sla-escalated',
        jobId: job.id,
        requestId: data.requestId,
        threshold: data.threshold,
        slaState: nextSlaState,
        escalationId: escalation.id,
      }
    },
  })
}
