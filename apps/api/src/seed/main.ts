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
  const { labour } = summary;
  lines.push(
    "",
    "Labour registry (synthetic people and identifiers):",
    `  ${labour.trades} trades; ${labour.gangs} gangs; ${labour.rates} new rates this run`,
    `  ${labour.labourersTotal} labourers (${labour.labourersCreated} created this run)`,
  );
  const { attendance } = summary;
  lines.push(
    "",
    `Attendance and timesheets (synthetic; ${attendance.created ? "created" : "already present"}):`,
    `  ${attendance.records} attendance records; ${attendance.periods} timesheet periods (${attendance.approvedPeriods} approved)`,
    `  ${attendance.openAnomalies} open anomalies; ${attendance.adjustments} adjustment(s); ${attendance.holidays} public holidays`,
  );
  const { payroll } = summary;
  lines.push(
    "",
    `Payroll (synthetic; statutory rules unverified, not for filing; ${payroll.created ? "created" : "already present"}):`,
    `  ${payroll.ruleVersions} statutory rule versions; ${payroll.minimumWages} minimum wages; ${payroll.allowances} allowances`,
    `  ${payroll.outputs} piece-rate outputs; ${payroll.advances} advances; ${payroll.submittedBatches} submitted and ${payroll.draftBatches} draft batches (${payroll.lines} lines)`,
  );
  const p2p = summary.procureToPay;
  lines.push(
    "",
    `Procure-to-pay (synthetic, ${p2p.created ? "created" : "already present"}): ${p2p.requisition} → ${p2p.rfq} → ${p2p.lpo} → ${p2p.grn}`,
  );
  for (const invoice of p2p.invoices) lines.push(`  invoice ${invoice.number} — ${invoice.status}`);
  const { stores } = summary;
  lines.push(
    "",
    `Stores (synthetic, ${stores.created ? "created" : "already present"}): ${stores.stores.join(", ")}`,
    `  ${stores.movements.join(", ")}; transfers ${stores.transfers.join(", ")}; stock take ${stores.stockTake}`,
    `  consumption variance alerts: ${stores.varianceAlerts}; low-stock items: ${stores.lowStock}`,
  );
  const { schedule } = summary;
  lines.push(
    "",
    `Schedule for RUI-HTS (synthetic, ${schedule.created ? "created" : "already present"}): ${schedule.activities} activities, ${schedule.dependencies} dependencies, ${schedule.baselines} baseline(s), ${schedule.delays} delays`,
  );
  const { spending } = summary;
  lines.push(
    "",
    `Spending for RUI-HTS (synthetic, ${spending.created ? "created" : "already present"}): budget ${spending.budget}; journal ${spending.journal}`,
    `  ${spending.float}: expenses ${spending.expenses.join(", ")}`,
    `  top-ups ${spending.topUps.join(", ")}; count ${spending.count}`,
    `  spend alerts: ${Object.entries(spending.alerts)
      .map(([kind, total]) => `${kind} ${total}`)
      .join(", ")}`,
  );
  const { quality } = summary;
  lines.push(
    "",
    `Quality (synthetic, ${quality.created ? "created" : "already present"}): ${quality.templates} checklist templates, ${quality.inspections} inspections, ${quality.snags} snags`,
    `  ${quality.cubeSets} cube sets (${quality.failedCubeSets} failed at 28 days, ${quality.overdueCubeSets} overdue); ${quality.slumpTests} slump tests; ${quality.diaries} diaries with an attendance workforce`,
    `  JUJ-DPX practical completion ${quality.practicalCompletion ?? "not certified"}; defects liability period ends ${quality.dlpEndsOn ?? "—"}`,
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
