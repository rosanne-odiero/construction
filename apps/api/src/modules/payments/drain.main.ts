import { NestFactory } from "@nestjs/core";

// Operator recovery after a queue (Valkey) outage: processes every due payment outbox row and
// stuck attempt directly, then exits. Safe to repeat. `pnpm --filter @pm-buddy/api payments:drain`
// after `pnpm --filter @pm-buddy/api build` (OPERATIONS "Payments: queue outage"). The background
// relay stays off in this process (set before the app module reads its configuration).
process.env["PAYMENTS_WORKERS_ENABLED"] = "false";
const { AppModule } = await import("../../app.module.js");
const { PaymentsRelay } = await import("./payments-relay.js");
const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
try {
  const processed = await app.get(PaymentsRelay).drain();
  console.log(`Drained ${processed} payment work item(s).`);
} finally {
  await app.close();
}
