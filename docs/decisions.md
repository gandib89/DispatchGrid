# DispatchGrid decision log

## DG-2 — Redis persistence (resolved, B11-T4)

**Verdict: reconcile choice.** Accept possible delayed-job loss on
non-persistent hosted Redis tiers, and repair it with a reconciliation sweep.
This is the stronger production and interview choice per `Dispatch_plan.md`
§5 (DG-2). Status: implemented — see `server/src/worker/reconcile.js` and
`server/src/test/worker/reconcile.test.js`.

### Evidence

- `docker-compose.yml:23-36` — local Redis is `redis:7-alpine` started with
  `redis-server --appendonly yes`, a named `redis_data:/data` volume, and a
  `redis-cli ping` healthcheck. Local/dev BullMQ state (delayed SLA timers,
  job states) survives container restarts via AOF.
- `server/.env.example:11` — `REDIS_URL=redis://localhost:6379`. No hosted
  Redis plan (Memorystore, ElastiCache, Upstash, or other) is selected
  anywhere in the repo; production deployment is C19/B19 scope, still open.
- BullMQ persistence need: delayed jobs and job state live in Redis. A hosted
  free tier without AOF/RDB persistence loses delayed work on eviction or
  restart. Until C19 selects a persistent hosted plan, that loss is accepted
  and documented here rather than silently assumed away.

### Consequence

- Redis holds no irreplaceable business fact: BullMQ storage, fan-out, rate
  limits, latest positions, narrow caches only. PostgreSQL is the sole source
  of truth — wiping Redis loses at most pending async work.
- `reconcileJobEvents` finds recently committed jobs with no `job-event` in
  any BullMQ state and re-enqueues them through the T1 producer. The
  threshold-based SLA variant (active jobs past threshold without an
  `Escalation`) lands with the `Escalation` table in B12; poison inspection
  is the T5 dead-letter path.

## Delivery contract — at-least-once with idempotent consumers

- Producers enqueue only after commit with minimal IDs plus the originating
  `requestId` (`server/src/lib/integration-adapters.js`, `server/src/lib/queue/index.js`).
- A post-commit enqueue failure is logged at the route seam
  (`server/src/routes/jobs.js:71-85`, hook failure never fails the request)
  and repaired by reconciliation. It never rolls back committed business state.
- Every queue payload is a request to evaluate work, not truth: handlers
  Zod-parse at entry, re-read PostgreSQL, and tolerate zero, one, or many
  deliveries (missing job = safe no-op; repeats = same outcome). Proven by
  `server/src/test/worker/handlers.test.js` and the T4 failure drill in
  `server/src/test/worker/reconcile.test.js`.
- The transactional outbox pattern stays unjustified: a single sweep over
  durable `JobEvent` rows covers the enqueue gap, and no measured loss
  trigger has appeared. Revisit if sweep cost or loss rate says otherwise.
