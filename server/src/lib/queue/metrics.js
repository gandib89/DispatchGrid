// Queue failure counters (B11-T5). Post-commit enqueue failures are logged at
// the route seam (routes/jobs.js) and counted here; dead-letter forwarding is
// counted at the worker seam. In-memory only — prom-client export and alert
// wiring stay B19's scope (production deployment, alerts, dashboards).
// Realtime publish parks use their own counter (never the queue metric) so
// queue dashboards stay meaningful; its export stays B19's scope too.
export const queueMetrics = {
  enqueueFailuresTotal: 0,
  deadLetteredTotal: 0,
  realtimePublishFailuresTotal: 0,
}

export function recordEnqueueFailure() {
  queueMetrics.enqueueFailuresTotal += 1
}

export function recordRealtimePublishFailure() {
  queueMetrics.realtimePublishFailuresTotal += 1
}

export function recordDeadLettered() {
  queueMetrics.deadLetteredTotal += 1
}

// Tests only: isolate counts between cases.
export function resetQueueMetrics() {
  queueMetrics.enqueueFailuresTotal = 0
  queueMetrics.deadLetteredTotal = 0
  queueMetrics.realtimePublishFailuresTotal = 0
}
