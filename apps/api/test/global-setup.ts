import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { testDatabaseUrls } from "./test-database.js";

/** Brings the e2e database up to the latest migration before any test boots the app. */
export default function setup(): void {
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  try {
    execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
      env: { ...process.env, DATABASE_MIGRATION_URL: testDatabaseUrls().migrationUrl },
      stdio: "pipe",
    });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    const output = `${stdout?.toString() ?? ""}${stderr?.toString() ?? ""}`;
    throw new Error(
      `Migrating the e2e database failed. Is \`pnpm services:up\` running?\n${output}`,
    );
  }
}
