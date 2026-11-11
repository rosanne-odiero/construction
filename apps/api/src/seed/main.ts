import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { assertSeedAllowed, seedDemo, type SeedSummary } from "./demo-seed.js";

/**
 * `pnpm db:seed` (development only): creates or tops up the synthetic demo company and prints the
 * demo credentials. `--reset-credentials` issues new passwords and a new owner TOTP secret.
 */
function print(summary: SeedSummary) {
  const lines = [
    `Demo company: ${summary.company.name} (${summary.company.created ? "created" : "already present"})`,
    "",
    "Accounts (synthetic, local development only):",
  ];
  for (const account of summary.accounts) {
    lines.push(`  ${account.displayName} — ${account.role}`);
    lines.push(`    sign in as: ${account.identifier}`);
    lines.push(
      account.password
        ? `    password:   ${account.password}`
        : "    password:   unchanged (run with --reset-credentials for a new one)",
    );
    if (account.totp) {
      lines.push(`    TOTP secret: ${account.totp.secret}`);
      lines.push(`    otpauth URI: ${account.totp.uri}`);
    }
  }
  lines.push("", "Projects:");
  for (const project of summary.projects)
    lines.push(
      `  ${project.code}  ${project.name} — ${project.status} (${project.created ? "created" : "already present"})`,
    );
  lines.push("", "Rate build-ups (synthetic example values):");
  for (const buildup of summary.buildups)
    lines.push(
      `  ${buildup.code}  ${buildup.name} — ${buildup.created ? "created" : "already present"}`,
    );
  lines.push(
    "",
    `Materials: ${summary.procurement.materials.created} added, ${summary.procurement.materials.existing} already present`,
    "Suppliers (synthetic):",
  );
  for (const supplier of summary.procurement.suppliers)
    lines.push(
      `  ${supplier.code}  ${supplier.name} — ${supplier.created ? "created" : "already present"}`,
    );
  console.log(lines.join("\n"));
}

try {
  assertSeedAllowed(process.env["NODE_ENV"]);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
try {
  print(await seedDemo(app, { resetCredentials: process.argv.includes("--reset-credentials") }));
} finally {
  await app.close();
}
