import assert from "node:assert/strict";
import { test } from "node:test";
import { NfcReader, type NfcTransport } from "../src/nfc.ts";

function fixture(platform: "android" | "ios", overrides: Partial<NfcTransport> = {}) {
  const calls: string[] = [];
  const transport: NfcTransport = {
    async isSupported() {
      calls.push("supported");
      return true;
    },
    async start() {
      calls.push("start");
    },
    async isEnabled() {
      calls.push("enabled");
      return true;
    },
    async request() {
      calls.push("request");
    },
    async token() {
      calls.push("token");
      return "worker-card";
    },
    async cancel() {
      calls.push("cancel");
    },
    ...overrides,
  };
  return { reader: new NfcReader(transport, platform, 20), calls };
}

test("iOS reads NDEF without an Android settings check; both platforms clean up after reading", async () => {
  for (const platform of ["android", "ios"] as const) {
    const { reader, calls } = fixture(platform);
    assert.equal(await reader.read(), "worker-card");
    assert.deepEqual(calls, [
      "supported",
      "start",
      ...(platform === "android" ? ["enabled"] : []),
      "request",
      "token",
      "cancel",
    ]);
  }
});

test("unsupported hardware and disabled Android NFC fail explicitly before opening a session", async () => {
  const unsupported = fixture("ios", {
    async isSupported() {
      return false;
    },
  });
  await assert.rejects(unsupported.reader.read(), /not supported.*Use QR/);
  assert.deepEqual(unsupported.calls, []);
  const disabled = fixture("android", {
    async isEnabled() {
      return false;
    },
  });
  await assert.rejects(disabled.reader.read(), /disabled/);
  assert.deepEqual(disabled.calls, ["supported", "start"]);
});

test("NDEF read failures and timeouts cancel the session, including a stalled tag read", async () => {
  for (const token of [
    async () => {
      throw new Error("Invalid NDEF card");
    },
    () => new Promise<string>(() => {}),
  ]) {
    const { reader, calls } = fixture("ios", { token });
    await assert.rejects(reader.read(), /Invalid NDEF|timed out/);
    assert.equal(calls.at(-1), "cancel");
  }
});

test("a scan cannot overlap cleanup; native cancellation cannot return a late worker token", async () => {
  let release!: () => void;
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { reader, calls } = fixture("ios", {
    async token() {
      reading();
      await pending;
      return "late-worker";
    },
  });
  const result = reader.read();
  await started;
  await assert.rejects(reader.read(), /already active/);
  await reader.cancel();
  release();
  await assert.rejects(result, /cancelled/);
  assert.equal(calls.at(-1), "cancel");
});

test("cleanup errors are visible and do not permanently prevent another scan", async () => {
  let fail = true;
  const { reader } = fixture("ios", {
    async cancel() {
      if (fail) {
        fail = false;
        throw new Error("NFC cleanup failed");
      }
    },
  });
  await assert.rejects(reader.read(), /cleanup failed/);
  assert.equal(await reader.read(), "worker-card");
});

test("the next scan waits for native session cleanup", async () => {
  let release!: () => void;
  let cleaning!: () => void;
  const started = new Promise<void>((resolve) => {
    cleaning = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { reader } = fixture("ios", {
    async cancel() {
      cleaning();
      await cleanup;
    },
  });
  const result = reader.read();
  await started;
  await assert.rejects(reader.read(), /already active/);
  release();
  assert.equal(await result, "worker-card");
});

test("a late timed-out request cannot read a card belonging to a later session", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const { reader, calls } = fixture("ios", {
    async request() {
      if (++requests === 1) await pending;
    },
  });
  await assert.rejects(reader.read(), /timed out/);
  assert.equal(await reader.read(), "worker-card");
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call === "token").length, 1);
});
