#!/bin/sh
# Creates the PM-Buddy roles and databases on the first start of the local Postgres container
# (ARCHITECTURE §6.1). In the cloud, infrastructure code creates the same roles.
#   pmb_migrator  owns the schema and runs migrations (DDL)
#   pmb_app       used by the API: DML only, no BYPASSRLS, so row-level security always applies
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migrator_password="$PMB_MIGRATOR_PASSWORD" \
  -v app_password="$PMB_APP_PASSWORD" <<'SQL'
CREATE ROLE pmb_migrator LOGIN PASSWORD :'migrator_password';
CREATE ROLE pmb_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE pmb OWNER pmb_migrator;
CREATE DATABASE pmb_test OWNER pmb_migrator;
SQL

for db in pmb pmb_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'SQL'
ALTER SCHEMA public OWNER TO pmb_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO pmb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pmb_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pmb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pmb_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pmb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pmb_migrator
  GRANT EXECUTE ON FUNCTIONS TO pmb_app;
SQL
done
