-- The runtime role is deliberately unable to bypass row-level security. The migration role
-- remains the table owner and applies schema changes through DATABASE_URL.
ALTER ROLE dispatchgrid_app
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS;

GRANT CONNECT ON DATABASE dispatchgrid TO dispatchgrid_app;
GRANT USAGE ON SCHEMA public TO dispatchgrid_app;
REVOKE CREATE ON SCHEMA public FROM dispatchgrid_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dispatchgrid_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO dispatchgrid_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dispatchgrid_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO dispatchgrid_app;

ALTER TABLE "Counter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Counter" FORCE ROW LEVEL SECURITY;

CREATE POLICY "Counter_organization_isolation"
ON "Counter"
FOR ALL
TO dispatchgrid_app
USING (
  "organizationId" = NULLIF(current_setting('app.organization_id', true), '')::uuid
)
WITH CHECK (
  "organizationId" = NULLIF(current_setting('app.organization_id', true), '')::uuid
);
