# DispatchGrid

DispatchGrid is a field-service dispatch platform. This repository currently contains the B00
through B11 foundation from `Dispatch_plan.md`: a React/Vite client, an Express API with
identity, organization/RBAC pipeline, shared contracts, pure job-domain rules,
database-enforced job truth, and transactional job services, Prisma for PostgreSQL, and Redis
for worker/cache infrastructure.

## Completed components

- **B00/C00:** domain contract, actor boundaries, lifecycle, FR/NFR/ADR traceability, fixed
  exclusions, and all current decision gates are recorded in
  [`docs/domain.md`](docs/domain.md) and [`docs/decisions.md`](docs/decisions.md).
- **B01/C01:** healthy PostgreSQL/Redis services, startup environment validation, Express process
  boundary, request context, logging redaction, HTTP errors, transaction/after-commit discipline,
  shared-contract boundary, lint, and tests.
- **B02/C02:** PostgreSQL identity/organization schema, migration/runtime database roles,
  organization-scoped Prisma access, Counter row-level security, idempotent seed data, and
  database-derived integration-test reset.
- **B03/C03:** registration (atomic User + Organization + roles + admin Membership), login,
  short-lived JWT access tokens, rotating opaque refresh families with reuse detection,
  `/api/v1/auth` routes, per-route auth rate limiting.
- **B04/C04:** request pipeline (authenticate → resolveTenant → authorize → audit), permission
  codes loaded once per request, organization list/create, member list/update, cross-tenant
  reads return 404.
- **B05/C05:** shared Zod contract factories (`shared/organization-schema.js`,
  `shared/job-schema.js`), stable error-code vocabulary, job/organization serializers with
  ISO dates and no internal-field leaks.
- **B06/C06:** pure job state machine (with retained `FAILED`), eligibility predicates, and
  deterministic Haversine-based suggestion scoring — all database-free and unit-tested.
- **B07/C07:** Job/Assignment/JobEvent tables with database-enforced invariants: coordinate
  ranges, status/assignee and completedAt consistency, per-org reference uniqueness, one
  active assignment per job (partial unique index), immutable JobEvent (trigger), and
  tenant-leading indexes proven by `EXPLAIN`.
- **B08/C08:** transactional job service with gapless `JOB-YYYY-NNNNNN` references, SAVEPOINT
  idempotency (replay, in-flight 409, reuse 422), atomic create/patch/start/complete/cancel/
  fail with ownership checks, and an ESLint boundary banning HTTP/queue/socket imports from
  services.
- **B09/C09:** assignment offers, accept/decline/reassign flows, deterministic suggestions,
  tenant ownership checks, and two-dispatcher race handling.
- **B10/C10:** job create/detail/board/timeline routes, lifecycle transitions, post-commit
  integration seams, and bounded board caching.
- **B11/C11:** shared BullMQ contracts, centralized queue connections, a separate worker,
  version-aware enqueue reconciliation, delayed-work and dead-letter paths, and delivery proofs.

The next component is B12/C12: durable, time-driven SLA warnings and breaches.

## Prerequisites

- Node.js 20.19+ or 22.12+ (Node.js LTS recommended)
- npm
- Docker Desktop with Docker Compose
- Git

Verify the tools from PowerShell:

```powershell
node --version
npm --version
docker --version
docker compose version
git --version
```

## First-time setup

Run these commands from `C:\Projects\DispatchGrid`:

```powershell
npm --prefix server install
npm --prefix client install

if (-not (Test-Path server\.env)) {
  Copy-Item server\.env.example server\.env
}

docker compose up -d --wait
docker compose ps

npm --prefix server run db:validate
npm --prefix server run db:migrate
npm --prefix server run db:generate
npm --prefix server run db:seed
```

DispatchGrid PostgreSQL is exposed on host port `55432` because local PostgreSQL services already
occupy `5432` and `5433`. Redis uses `6379`.

## Start development

Open separate PowerShell terminals from the repository root.

API:

```powershell
npm --prefix server run dev
```

Worker foundation:

```powershell
npm --prefix server run worker
```

Frontend:

```powershell
npm --prefix client run dev
```

Open `http://localhost:5173`. The frontend calls the API health endpoint at
`http://localhost:3000/healthz`.

## Useful commands

```powershell
# Start and inspect local services
docker compose up -d --wait
docker compose ps
docker compose logs -f

# Stop services without deleting data
docker compose stop

# Server verification
npm --prefix server run lint
npm --prefix server test
npm --prefix server run db:validate
npm --prefix server run db:generate
npm --prefix server run db:migrate
npm --prefix server run db:seed

# Client verification
npm --prefix client run lint
npm --prefix client test
npm --prefix client run build
```

`docker compose down` removes the containers and network but preserves the named database/Redis
volumes. Do not add `--volumes` unless you intentionally want to erase local service data.

## Environment configuration

Local defaults live in `server/.env.example`. The actual `server/.env` file is ignored by Git.

- `DATABASE_URL`: privileged connection used by Prisma migrations
- `APP_DATABASE_URL`: restricted connection used by application code
- `REDIS_URL`: Redis connection used by the worker and later queue/cache modules
- `JWT_SECRET`: local signing secret; replace it in every deployed environment
- GCS, Sentry, and Gemini values are optional until their respective components are implemented

## Current boundary

This completes B00/C00 through B11/C11, not the full product. SLA policy effects,
notifications, Socket.IO authentication, tracking, file uploads, and production deployment
are implemented in later components of `Dispatch_plan.md`.

## B00/B01 verification evidence

The current automated checks prove:

- missing `JWT_SECRET` fails with a named startup configuration error;
- optional Gemini configuration does not block startup when disabled;
- importing `server/src/app.js` exits without opening a listener;
- `/healthz` returns exactly `200 {"status":"ok"}` without checking PostgreSQL or Redis;
- request IDs are generated or preserved and API errors use the stable envelope;
- after-commit callbacks do not execute when a transaction fails;
- server/client lint and tests pass, Prisma validates/generates, and the client builds;
- Docker Compose waits until PostgreSQL 16 and Redis 7 are both healthy.

The C02 integration checks additionally prove:

- seed reruns retain identical logical counts and include a shadow organization;
- the runtime connection is `dispatchgrid_app`, not a superuser and not `BYPASSRLS`;
- an Organization A session cannot read or write Organization B's Counter;
- normal tenant-scoped Prisma reads automatically include `organizationId`;
- membership uniqueness and same-organization role foreign keys are database invariants;
- test reset discovers a newly created table from PostgreSQL instead of using a table list.

## B03–B06 verification evidence

Live smoke tests against local services prove:

- register → login → `/auth/me` → refresh → logout returns 201/200/200/200/204;
- reusing a rotated refresh token revokes the family and returns 401;
- registration sets the `app.organization_id` context so the Counter RLS policy accepts the
  new organization's `job-reference` row;
- admin member update returns 200 while an agent attempt returns 403;
- cross-organization member reads return 404, not 403.

Unit tests prove:

- unknown contract fields are rejected; board `pageSize` caps at 100;
- clients branch on `error.code` (`version_conflict`, etc.);
- serializers emit ISO dates and never leak internal fields;
- every legal/illegal job transition behaves per DG-1, `CANCELLED` is reachable from all
  non-terminal states, and terminal states have no exits;
- eligibility rejects wrong org/role, unavailable agents, and exact-cap agents, and prefers
  the membership cap override;
- scoring is deterministic, stable on ties (userId break), and correct across the
  antimeridian.
- concurrent creates receive consecutive gapless references; rollback consumes no number;
- same key/body replays the identical stored response; same key/different body yields 422;
  in-flight keys yield 409; a lost completion response replays instead of re-executing;
- every transition writes job plus timeline event atomically; stale versions yield 409 with
  current state; cross-organization access yields 404; scope is checked before permission;
- services import no HTTP, queue, or socket modules (unit-tested and ESLint-enforced).

## Local seed identities

`npm --prefix server run db:seed` creates these development-only users with password
`ChangeMe123!`:

- `admin@dispatchgrid.local`
- `dispatcher@dispatchgrid.local`
- `agent@dispatchgrid.local`
- `agent@shadow.dispatchgrid.local`

Login is available at `POST /api/v1/auth/login` with password `ChangeMe123!`.
