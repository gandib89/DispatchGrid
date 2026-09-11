// Post-commit integration seam (B10-T4). No-ops until queue (B11) and
// realtime (B15) consumers land. Routes call these AFTER the service promise
// resolves (commit done) and after cache invalidation. Never import this from
// services or transactions — nothing may enqueue, publish, or invalidate
// inside a transaction.
export const integrationAdapters = {
  async publishJobEvent(_payload) {},
  async enqueueJobWork(_payload) {},
}

export async function publishJobEvent(payload) {
  await integrationAdapters.publishJobEvent(payload)
}

export async function enqueueJobWork(payload) {
  await integrationAdapters.enqueueJobWork(payload)
}
