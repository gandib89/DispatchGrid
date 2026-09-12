import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { consumeJob } from './consume-job.js'
import { sendNotification } from '../../lib/notifications/email-stub.js'

const schemas = queueSchemas(z)

function isUniqueViolation(error) {
  return error?.code === 'P2002'
}

// Retryable delivery (B13): check → send → record. A prior SENT record means
// no-op; every attempt (success or failure) is counted with a timestamp on
// the durable row without ever touching the originating job, assignment, or
// escalation rows. Failures rethrow so BullMQ retries per the notification
// queue's attempts/backoff; exhaustion lands on the existing dead-letter
// path. Concurrent duplicate deliveries serialize on the upsert: one row,
// SENT, never a second consequence.
//
// Known window (documented, not hidden): if the provider accepts the message
// and the process dies before recording success, a duplicate can escape.
// Closing it needs provider idempotency keys or a transactional outbox.
export async function handleNotification(payload, deps = {}) {
  return consumeJob(payload, deps, {
    handler: 'notification',
    schema: schemas.notificationPayloadSchema,
    unprocessablePrefix: 'Unprocessable notification payload',
    missingLog: 'notification for unknown job; acknowledging as no-op',
    onJobFound: async (job, data, log) => {
      const key = {
        jobId: job.id,
        type: data.notificationType,
        recipientId: data.recipientId,
      }

      const prior = await deps.prisma.notification.findFirst({
        where: { ...key, organizationId: job.organizationId },
      })
      if (prior?.status === 'SENT') {
        log.info({ notificationType: data.notificationType }, 'Notification already sent; acknowledging as complete')
        return {
          status: 'notification-already-sent',
          jobId: job.id,
          requestId: data.requestId,
          notificationType: data.notificationType,
          recipientId: data.recipientId,
        }
      }

      const send = deps.sendNotification ?? sendNotification
      const now = new Date()
      try {
        await send({
          jobId: job.id,
          organizationId: job.organizationId,
          notificationType: data.notificationType,
          recipientId: data.recipientId,
          escalationId: data.escalationId,
          requestId: data.requestId,
        })
      } catch (error) {
        // Count the attempt, keep the row retryable, never downgrade a
        // concurrent SENT, then rethrow for BullMQ redelivery.
        const matched = await deps.prisma.notification.updateMany({
          where: { ...key, status: 'PENDING' },
          data: { attempts: { increment: 1 }, lastAttemptAt: now },
        })
        if (matched.count === 0 && !prior) {
          await deps.prisma.notification
            .create({
              data: {
                organizationId: job.organizationId,
                ...key,
                status: 'PENDING',
                attempts: 1,
                lastAttemptAt: now,
              },
            })
            .catch((createError) => {
              if (!isUniqueViolation(createError)) throw createError
            })
        }
        throw error
      }

      const record = await deps.prisma.notification.upsert({
        where: { jobId_type_recipientId: key },
        create: {
          organizationId: job.organizationId,
          ...key,
          status: 'SENT',
          attempts: 1,
          lastAttemptAt: now,
          sentAt: now,
        },
        update: {
          status: 'SENT',
          attempts: { increment: 1 },
          lastAttemptAt: now,
          sentAt: now,
        },
      })

      log.info(
        { notificationType: data.notificationType, notificationId: record.id, attempts: record.attempts },
        'Notification recorded as sent',
      )
      return {
        status: 'notification-sent',
        jobId: job.id,
        requestId: data.requestId,
        notificationType: data.notificationType,
        recipientId: data.recipientId,
        attempts: record.attempts,
      }
    },
  })
}
