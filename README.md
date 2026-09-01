# DispatchGrid

DispatchGrid is a field-service dispatch platform. This repository currently contains the C01
runtime foundation from `Dispatch_plan.md`: a React/Vite client, an Express API, Prisma for
PostgreSQL, and Redis for worker/cache infrastructure.

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

docker compose up -d
docker compose ps

npm --prefix server run db:validate
npm --prefix server run db:generate
```

DispatchGrid PostgreSQL is exposed on host port `5433`, because host port `5432` was already in
use when the project was initialized. Redis uses `6379`.

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
docker compose up -d
docker compose ps
docker compose logs -f

# Stop services without deleting data
docker compose stop

# Server verification
npm --prefix server run lint
npm --prefix server test
npm --prefix server run db:validate
npm --prefix server run db:generate

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

This is the runtime foundation, not the completed product. Identity, tenancy, jobs, assignments,
BullMQ handlers, Socket.IO authentication, tracking, file uploads, and production deployment are
implemented in later components of `Dispatch_plan.md`.
