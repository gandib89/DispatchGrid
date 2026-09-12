import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { consumeJob } from './consume-job.js'
import { integrationAdapters } from '../../lib/integration-adapters.js'

const schemas = queueSchemas(z)

// Terminal states never escalate (DG-1: FAILED is retained as terminal).
const TERMINAL_JOB_STATUSES = Object.freeze(['COMPLETED', 'CANCELLED', 'FAILED'])

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
  return consumeJob(payload, deps, {
    handler: 'sla-check',
    schema: schemas.slaCheckPayloadSchema,
    unprocessablePrefix: 'Unprocessable sla-check payload',
    missingLog: 'sla-check for unknown job; acknowledging as no-op',
    found: async (job, data, log) => {
      if (TERMINAL_JOB_STATUSES.includes(job.status)) {
        log.info({ jobStatus: job.status, threshold: data.threshold }, 'SLA check on terminal job; acknowledging as no-op')
        return { status: 'sla-terminal-noop', jobId: job.id, requestId: data.requestId, threshold: data.threshold }
      }

      // WARNING never downgrades an already-BREACHED job, but still records
      // its own escalation row; a BREACH without a prior warning converges
      // straight to BREACHED.
      const nextSlaState =
        data.threshold === 'BREACH' ? 'BREACHED' : job.slaState === 'BREACHED' ? 'BREACHED' : 'WARNING'

      let escalation
      try {
        escalation = await deps.prisma.$transaction(async (tx) => {
          await tx.job.update({ where: { id: job.id }, data: { slaState: nextSlaState } })
          return tx.escalation.create({
            data: { organizationId: data.organizationId, jobId: job.id, threshold: data.threshold },
          })
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          log.info({ threshold: data.threshold }, 'SLA escalation already recorded; acknowledging as complete')
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
        const publish = deps.publishEscalationEvent ?? integrationAdapters.publishJobEvent
        const enqueue = deps.enqueueEscalationNotification ?? integrationAdapters.enqueueJobWork
        await publish({
          jobId: job.id,
          organizationId: data.organizationId,
          escalationId: escalation.id,
          threshold: data.threshold,
          requestId: data.requestId,
        })
        await enqueue({ jobId: job.id, organizationId: data.organizationId, requestId: data.requestId })
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
