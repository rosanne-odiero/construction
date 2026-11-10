import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Same rule as the API (src/config/app-config.ts): `.env` first, `.env.example` fills gaps
// outside production, so a fresh clone can migrate the local database without extra setup.
if (process.env["NODE_ENV"] !== "production") {
  config({ path: [".env", ".env.example"], quiet: true });
}

// Migrations run as the schema owner (pmb_migrator); the API connects as pmb_app (ARCHITECTURE §6.1).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_MIGRATION_URL"] ?? process.env["DATABASE_URL"],
  },
});
