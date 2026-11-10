import { config } from "dotenv";

const TEST_DATABASE = "pmb_test";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * e2e tests run against their own database (created by infra/docker/postgres/init) so they never
 * touch development data. The URLs follow DATABASE_URL / DATABASE_MIGRATION_URL with only the
 * database name swapped, so overrides in .env carry over.
 */
export function testDatabaseUrls(): { appUrl: string; migrationUrl: string } {
  config({ path: [".env", ".env.example"], quiet: true });
  const appUrl = process.env["DATABASE_URL"];
  if (!appUrl) throw new Error("DATABASE_URL is not set (see apps/api/.env.example)");
  return {
    appUrl: withDatabase(appUrl, TEST_DATABASE),
    migrationUrl: withDatabase(process.env["DATABASE_MIGRATION_URL"] ?? appUrl, TEST_DATABASE),
  };
}
