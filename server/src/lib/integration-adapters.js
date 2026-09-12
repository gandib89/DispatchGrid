// Post-commit integration seam (B10-T4, wired B11-T2). Routes call
// afterJobCommit AFTER the service promise resolves (commit done) and after
// cache invalidation. Never import this from services or transactions —
// nothing may enqueue, publish, or invalidate inside a transaction.
import { enqueueJobEvent } from './queue/index.js'

export const integrationAdapters = {
  // Realtime fan-out lands in B15.
  async publishJobEvent(_payload) {},
  async enqueueJobWork(payload) {
    await enqueueJobEvent({
      type: 'job-event',
      jobId: payload.jobId,
      organizationId: payload.organizationId,
      requestId: payload.requestId,
    })
  },
}

export async function afterJobCommit(payload) {
  await integrationAdapters.publishJobEvent(payload)
  await integrationAdapters.enqueueJobWork(payload)
}
