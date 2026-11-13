import { startMockDaraja } from "./server.js";

// `pnpm --filter @pm-buddy/mock-daraja start`: the mock on loopback (default port 4690). Development
// and tests only; it never contacts Safaricom and moves no money.
const port = Number(process.env["MOCK_DARAJA_PORT"] ?? 4690);
const mock = await startMockDaraja({
  port,
  callbackDelayMs: Number(process.env["MOCK_DARAJA_CALLBACK_DELAY_MS"] ?? 500),
  responseDelayMs: Number(process.env["MOCK_DARAJA_RESPONSE_DELAY_MS"] ?? 20_000),
  externalValidation: process.env["MOCK_DARAJA_EXTERNAL_VALIDATION"] === "true",
  log: (line) => console.log(`[mock-daraja] ${line}`),
});
console.log(
  `[mock-daraja] listening on ${mock.url} (TEST ONLY; certificate at ${mock.url}/__mock/certificate)`,
);
const stop = () => {
  void mock.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
