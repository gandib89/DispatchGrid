# DispatchGrid decision log

## DG-1 — Failed job state (resolved, B06)

**Verdict:** retain `FAILED` as a terminal state. It is reachable through
`POST /api/v1/jobs/:id/fail`, requires `job.respond` plus a reason, retains the
current assignee, and is covered by domain, service, route, and database tests.

## DG-3 — Recommendation ledger

- **No soft deletion: accepted.** Core records remain auditable through status
  and immutable event/history rows; no `deletedAt` convention is introduced.
- **One GCP project with isolated staging services/database: accepted.** This is
  the C19 deployment target; staging and production never share a database.
- **SLA policy edits do not reschedule existing jobs: accepted.** Only newly
  assigned jobs use the edited policy, as also recorded in `docs/domain.md`.
- **Nullable `LocationPing.jobId`: accepted.** B14 may store an agent location
  without associating it with a job.
- **OpenAPI generation: overridden.** No OpenAPI surface is planned for the
  current build; shared strict Zod contracts remain the executable boundary.
- **`/readyz` checks PostgreSQL and Redis: accepted.** The endpoint belongs to
  C19; `/healthz` remains a process-only liveness check.
- **LedgerLine supporting-table DDL reuse: overridden.** DispatchGrid owns its
  schema through Prisma models and reviewed migrations as each component lands.

## DG-2 — Redis persistence and B11 recovery (resolved, B11-T4)

**Verdict:** local Redis uses AOF persistence. No production Redis tier is
selected yet, so loss of generic delayed SLA jobs is explicitly accepted in
B11; B12 must revisit that choice when durable SLA thresholds and Escalations
exist. B11's recoverable job-event enqueue gap is repaired independently by
`server/src/worker/reconcile.js` and proven in
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
- `reconcileJobEvents` compares each job's durable version with retained
  `job-event` payload versions in every BullMQ state and re-enqueues missing
  current versions through the T1 producer, including terminal transitions. The
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
  durable `Job` versions covers the current-state enqueue gap, and no measured loss
  trigger has appeared. Revisit if sweep cost or loss rate says otherwise.

## Scale plan — API scale-to-zero, worker min-instances=1 (story 8)

**Verdict:** the API is stateless and may scale to zero; the worker keeps
`min-instances=1` so delayed BullMQ work (e.g. generic `sla-check` timers) has
a consumer when its delay elapses. Source: `Dispatch_plan.md` B11 slice 9
(`[DECIDED]`). Status: recorded, enforcement lands with C19/B19 deployment.

## Limiter policy under Redis loss

**Verdict:** HTTP rate limiters are process-local (`server/src/lib/rate-limit.js`,
no Redis store), so they enforce identically with Redis up or down —
fail-open with respect to Redis: an outage neither loosens nor tightens HTTP
budgets. During an outage REST keeps its configured budgets while async work
pauses (post-commit enqueue failure is warned + counted, never rolls back).
Proven by `server/src/test/queue/dead-letter.test.js` (Redis-out drill). Do
not add a Redis-backed limiter without revisiting this policy.

## Reconcile framing — B11 sweep vs B12 SLA variant

**Verdict:** the B11 sweep (`reconcileJobEvents`) repairs commit-without-enqueue
by comparing durable Job versions with retained queue payload versions and
re-enqueuing any missing current version through the T1 producer. Terminal
transitions qualify and are safe because consumers reread PostgreSQL. The
threshold-based SLA variant (active jobs past threshold without an `Escalation`) lands with the
`Escalation` table in B12, as does the `sla-check` threshold vocabulary.

## DG-4 — SLA breach timing formula (resolved, B12-T1)

**Verdict:** warning and breach evaluation times derive from the job deadline
as `warningAt = dueAt − warningMinutesBefore` and
`breachAt = dueAt + breachMinutesAfter`. Offset zero is valid on both sides:
a zero `warningMinutesBefore` warns exactly at `dueAt`, and a zero
`breachMinutesAfter` breaches exactly at `dueAt` (the nonnegative-threshold
CHECK permits zero; proven by `server/src/test/db/sla-constraints.test.js`).
Status: recorded; scheduling and handler enforcement land in B12-T2/T3.

## A-6 — no rescheduling on policy edit (resolved, B12-T1)

**Verdict:** editing an SLA policy applies only to newly assigned jobs. Already
enqueued delayed warning/breach work keeps the thresholds promised at
assignment time and is never rescheduled. Rationale: an assignment is a
promise made with specific thresholds; silently shifting existing timers would
rewrite that promise. Handler-side safety comes from re-reading tenant-scoped
job and policy data before acting, so stale timers against terminal jobs are
safe no-ops. Status: recorded; assignment-time snapshotting lands in B12-T2.

## SLA policy selection — earliest-created wins (resolved, B12 review)

**Verdict:** when an organization holds several policies, assignment arms the
job's clock from the earliest-created policy (`createdAt`, then `id` as the
tiebreak) until a job→policy association exists. This is an explicit stopgap,
not a ranking: no priority, specificity, or job-type matching is implied.
Re-assign counts as a new assignment — it drops the stale pair and re-arms
from the current earliest policy. Status: recorded and pinned by a
multi-policy test; replace with a real association when a second selection
signal is needed. Do not build policy association on this ticket.

## B11→B12 queue upgrade — legacy sla-check timers drain as no-ops

**Verdict:** B11 delayed `sla-check` timers carry no threshold promise and fail
B12 strict parsing. Both the router and the handler recognize that shape and
acknowledge it (`sla-legacy-noop` — no writes, no fan-out) instead of
poisoning it onto the dead-letter path. Upgrade path: deploy freely — stale
B11 timers drain harmlessly while every new assignment arms threshold
payloads. No Redis drain or obliteration required.
