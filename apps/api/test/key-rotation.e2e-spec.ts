import { createHash, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { PrismaPg } from "@prisma/adapter-pg";
import { Secret, TOTP } from "otpauth";
import type { ApiEnv } from "@pm-buddy/validation";
import { paymentSettingsResponseSchema, revealResponseSchema } from "@pm-buddy/validation";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { AppConfig } from "../src/config/app-config.js";
import { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { FIELD_COLUMNS, KeyRotation } from "../src/keys/key-rotation.js";
import { parseSealKeys, SealedSecrets } from "../src/modules/identity/sealed-secrets.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { LabourCrypto } from "../src/modules/labour/labour-support.js";
import { FieldCipher, parseFieldKeys } from "../src/modules/labour/field-cipher.js";
import { seedDemo, type SeedSummary } from "../src/seed/demo-seed.js";
import { Browser } from "./support.js";
import { testDatabaseUrls } from "./test-database.js";

/** Deterministic, test-only keys (never used outside this drill). */
const key = (label: string) =>
  createHash("sha256").update(`pm-buddy key rotation drill: ${label}`).digest("hex");
const F1 = key("field v1");
const F2 = key("field v2");
const M1 = key("mfa v1");
const M2 = key("mfa v2");

/** Synthetic Daraja values for the drill company (mock environment; never real credentials). */
const PAYMENT_SECRETS = {
  consumerKey: "key-drill-consumer-key",
  consumerSecret: "key-drill-consumer-secret",
  initiatorName: "keydrillinitiator",
  initiatorPassword: "Key#Drill$Initiator",
  passkey: "key-drill-passkey-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
};

/** AppConfig with the key variables of one rotation phase; everything else from the test env. */
class PhaseConfig extends AppConfig {
  constructor(
    config: ConfigService<ApiEnv, true>,
    private readonly overrides: Partial<ApiEnv>,
  ) {
    super(config);
  }

  override get<K extends keyof ApiEnv>(name: K): ApiEnv[K] {
    return name in this.overrides ? (this.overrides[name] as ApiEnv[K]) : super.get(name);
  }
}

async function appWith(overrides: Partial<ApiEnv>): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useFactory({
      factory: (config: ConfigService<ApiEnv, true>) => new PhaseConfig(config, overrides),
      inject: [ConfigService],
    })
    .compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.init();
  return app;
}

const blindIndexKey = () => process.env["FIELD_BLIND_INDEX_KEY"]!;
const fieldCipher = (keys: string, active: number) =>
  new FieldCipher(parseFieldKeys(keys, active, blindIndexKey()));
const sealed = (keys: string, active?: number) => new SealedSecrets(parseSealKeys(keys, active)!);
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

type Stored = { table: string; column: string; id: string; value: Uint8Array };

/**
 * The D9.1 key rotation drill (docs/OPERATIONS.md "Key rotation"), end to end on the real
 * database: data written under key version 1 → version 2 added and active → reads still work →
 * keys:rotate rewrap (as the schema owner) → version 1 removed → reads still work, and no version 1
 * ciphertext is left. Limited to this test's own company, so parallel tests keep their keys.
 */
describe("Key rotation drill (field encryption and TOTP seeds)", () => {
  let owner: PrismaClient;
  let summary: SeedSummary;
  let tenantId: string;
  let ownerAccount: SeedSummary["accounts"][number];
  const plaintexts = new Map<string, string>();
  const originals = new Map<string, string>();
  let mfaOriginal = "";
  let ownerUserId = "";
  let lastTotpStep = 0;

  /** Every stored field ciphertext of the drill company, read as the schema owner. */
  const stored = async (): Promise<Stored[]> =>
    owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const rows: Stored[] = [];
      for (const { table, column, rowKey } of FIELD_COLUMNS) {
        const found = await tx.$queryRaw<{ id: string; value: Uint8Array }[]>(Prisma.sql`
          SELECT ${Prisma.raw(rowKey)}::text AS id, ${Prisma.raw(column)} AS value
            FROM ${Prisma.raw(table)}
           WHERE tenant_id = ${tenantId}::uuid AND ${Prisma.raw(column)} IS NOT NULL`);
        rows.push(...found.map((row) => ({ table, column, ...row })));
      }
      return rows;
    });
  const context = (row: Stored) => ({
    tenantId,
    table: row.table,
    column: row.column,
    rowId: row.id,
  });
  const ownerSecret = async () =>
    (await owner.user.findUniqueOrThrow({ where: { id: ownerUserId } })).mfaSecret!;

  /** Signs the seeded owner in through the API (password and TOTP), in the drill company. */
  async function signIn(app: INestApplication<App>) {
    const browser = new Browser(app);
    browser.identifier = ownerAccount.identifier;
    await browser.initialize();
    const login = await browser.call("post", "auth/login", {
      identifier: ownerAccount.identifier,
      password: ownerAccount.password,
    });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    // Each sign-in uses a time step not used before (a TOTP code is accepted once), and the API
    // accepts the current step ±1: wait while the next unused step is further ahead than that.
    const stepOf = () => Math.floor(Date.now() / 30_000);
    const step = Math.max(stepOf(), lastTotpStep + 1);
    while (step > stepOf() + 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    lastTotpStep = step;
    const code = new TOTP({ secret: Secret.fromBase32(ownerAccount.totp!.secret) }).generate({
      timestamp: step * 30_000,
    });
    const stepUp = await browser.call("post", "auth/mfa/step-up", { code });
    expect(stepUp.status, JSON.stringify(stepUp.body)).toBe(200);
    expect((await browser.call("post", `tenants/${tenantId}/select`, {})).status).toBe(200);
    return browser;
  }

  async function reveal(browser: Browser, labourerId: string) {
    const revealed = await browser.call("post", `labour/labourers/${labourerId}/reveal`, {
      field: "idNumber",
      purpose: "identity_verification",
    });
    expect(revealed.status, JSON.stringify(revealed.body)).toBe(200);
    return revealResponseSchema.parse(revealed.body).value;
  }

  const signInAndReveal = async (app: INestApplication<App>, labourerId: string) =>
    reveal(await signIn(app), labourerId);

  const paymentSettings = async (browser: Browser) => {
    const res = await browser.call("get", "payments/settings");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return paymentSettingsResponseSchema.parse(res.body).settings!;
  };

  /**
   * D4.2 payments through the API's own endpoints: settings with all five credentials and a
   * callback route, one request with a phone number, and one received callback (workers are off,
   * so nothing is sent or processed).
   */
  async function seedPayments(app: INestApplication<App>) {
    const browser = await signIn(app);
    expect((await browser.call("post", "payments/settings", {})).status).toBe(201);
    const shortcodes = {
      stkShortcode: "174379",
      stkPartyB: null,
      stkTransactionType: "CustomerPayBillOnline",
      c2bShortcode: "600966",
      b2cShortcode: "600992",
      b2bShortcode: "600993",
    };
    const limits = {
      stkMaxMinor: 25_000_000,
      b2cMinMinor: 1_000,
      b2cMaxMinor: 25_000_000,
      b2bMaxMinor: 25_000_000,
      dailyPayoutMaxMinor: 2_000_000_000,
    };
    const updated = await browser.call("put", "payments/settings", {
      version: (await paymentSettings(browser)).version,
      environment: "mock",
      shortcodes,
      limits,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const credentials = await browser.call("put", "payments/settings/credentials", {
      version: (await paymentSettings(browser)).version,
      ...PAYMENT_SECRETS,
    });
    expect(credentials.status, JSON.stringify(credentials.body)).toBe(200);
    const created = await browser.call(
      "post",
      "payments/requests",
      { kind: "stk_push", amountMinor: 10_000, phone: "0708374149", accountReference: "KEY-DRILL" },
      true,
      { "Idempotency-Key": `key-drill-${randomUUID()}` },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const hook = (await paymentSettings(browser)).callbackUrls.find(
      (entry) => entry.kind === "stk",
    )!;
    const received = await request(app.getHttpServer())
      .post(new URL(hook.url).pathname)
      .set("Content-Type", "application/json")
      .send(
        JSON.stringify({
          Body: {
            stkCallback: {
              MerchantRequestID: "key-drill",
              CheckoutRequestID: "ws_CO_key_drill",
              ResultCode: 1032,
              ResultDesc: "Request cancelled by user",
            },
          },
        }),
      );
    expect(received.status).toBe(200);
  }

  beforeAll(async () => {
    owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    // Phase 1: everything written under version 1 by the API's own code (the demo seed).
    const v1 = await appWith({
      FIELD_ENCRYPTION_KEYS: `1:${F1}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: 1,
      AUTH_MFA_ENCRYPTION_KEY: M1,
      AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION: undefined,
    });
    try {
      summary = await seedDemo(v1, { namespace: `keys-${randomUUID().slice(0, 8)}` });
      tenantId = summary.company.id;
      ownerAccount = summary.accounts.find((account) => account.role === "owner")!;
      ownerUserId = (await owner.user.findUniqueOrThrow({
        where: { identifier: ownerAccount.identifier },
      }))!.id;
      // The seed leaves NSSF, SHA and next of kin empty: fill them for one labourer (as the API
      // would), so every encrypted column takes part in the drill.
      const crypto = v1.get(LabourCrypto);
      await v1
        .get(TenantDatabase)
        .run({ userId: ownerUserId, tenantId, requestId: "key-drill" }, async (tx) => {
          const { id } = await tx.labourer.findFirstOrThrow({ where: { tenantId } });
          await tx.labourer.update({
            where: { id },
            data: {
              nssfNumberEnc: crypto.seal(tenantId, id, "nssf_number_enc", "2000123456"),
              shaNumberEnc: crypto.seal(tenantId, id, "sha_number_enc", "CR0123456789012-1"),
              nextOfKinEnc: crypto.seal(
                tenantId,
                id,
                "next_of_kin_enc",
                JSON.stringify({ name: "Synthetic Kin", relationship: "sibling" }),
              ),
            },
          });
        });
      await seedPayments(v1);
    } finally {
      await v1.close();
    }
    const cipher = fieldCipher(`1:${F1}`, 1);
    for (const row of await stored()) {
      const id = `${row.table}.${row.column}.${row.id}`;
      plaintexts.set(id, cipher.decrypt(context(row), row.value));
      originals.set(id, hex(row.value));
    }
    mfaOriginal = await ownerSecret();
  }, 300_000);

  afterAll(async () => {
    await owner?.$disconnect();
  });

  it("rotates every encrypted column and the TOTP seeds without losing a value", async () => {
    // The seed covers every encrypted column, all on version 1.
    const columns = new Set(
      [...plaintexts.keys()].map((id) => id.split(".").slice(0, 2).join(".")),
    );
    expect([...columns].sort()).toEqual(
      FIELD_COLUMNS.map(({ table, column }) => `${table}.${column}`).sort(),
    );
    expect((await stored()).every((row) => row.value[1] === 1)).toBe(true);
    expect(sealed(M1).versionOf(mfaOriginal)).toBe(1);
    const labourer = [...plaintexts.keys()].find((id) => id.startsWith("labourers.id_number_enc"))!;
    const labourerId = labourer.split(".")[2]!;
    const phoneChanges = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.supplierPhoneChange.count({ where: { tenantId } });
    });

    // Phase 2: version 2 added and active. Old values still read through the API.
    const both = {
      FIELD_ENCRYPTION_KEYS: `1:${F1},2:${F2}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: 2,
      AUTH_MFA_ENCRYPTION_KEY: `1:${M1},2:${M2}`,
      AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION: 2,
    };
    const v12 = await appWith(both);
    try {
      expect(await signInAndReveal(v12, labourerId)).toBe(plaintexts.get(labourer));
    } finally {
      await v12.close();
    }

    const rotation = new KeyRotation(owner, {
      field: fieldCipher(both.FIELD_ENCRYPTION_KEYS, 2),
      sealed: sealed(both.AUTH_MFA_ENCRYPTION_KEY, 2),
    });
    await rotation.assertOwner();
    const before = await rotation.fieldStatus(tenantId);
    for (const counts of Object.values(before)) expect(Object.keys(counts)).toEqual(["v1"]);

    // A dry run reads every old value and writes nothing.
    const dry = await rotation.rewrapFields({ operator: "D9.1 drill", tenantId, dryRun: true });
    expect([dry.checked, dry.rewrapped, dry.failed]).toEqual([plaintexts.size, 0, 0]);
    expect((await stored()).every((row) => row.value[1] === 1)).toBe(true);

    const fields = await rotation.rewrapFields({ operator: "D9.1 drill", tenantId, batchSize: 7 });
    expect(fields).toMatchObject({ status: "completed", checked: plaintexts.size, failed: 0 });
    expect(fields.rewrapped).toBe(plaintexts.size);
    const mfa = await rotation.rewrapMfa({ operator: "D9.1 drill", tenantId });
    expect(mfa).toMatchObject({ status: "completed", failed: 0 });
    expect(mfa.rewrapped).toBeGreaterThanOrEqual(1);
    // Idempotent: a second run finds nothing left on version 1.
    expect((await rotation.rewrapFields({ operator: "D9.1 drill", tenantId })).checked).toBe(0);
    expect((await rotation.rewrapMfa({ operator: "D9.1 drill", tenantId })).checked).toBe(0);

    const runs = await owner.keyRotationRun.findMany({
      where: { id: { in: [dry.runId, fields.runId, mfa.runId] } },
    });
    expect(runs).toHaveLength(3);
    for (const run of runs)
      expect(run).toMatchObject({ operator: "D9.1 drill", tenantId, targetVersion: 2 });
    expect(runs.find((run) => run.id === fields.runId)).toMatchObject({
      status: "completed",
      rowsRewrapped: plaintexts.size,
      dryRun: false,
    });
    // Re-encrypting a phone is not a phone change: no new change records.
    expect(
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.supplierPhoneChange.count({ where: { tenantId } });
      }),
    ).toBe(phoneChanges);

    // Phase 3: version 1 removed. Every value reads under version 2 alone, and no version 1
    // ciphertext is left; the old key can no longer read anything.
    const v2Only = fieldCipher(`2:${F2}`, 2);
    const v1Only = fieldCipher(`1:${F1}`, 1);
    const after = await stored();
    expect(after).toHaveLength(plaintexts.size);
    for (const row of after) {
      const id = `${row.table}.${row.column}.${row.id}`;
      expect(row.value[1], id).toBe(2);
      expect(hex(row.value), id).not.toBe(originals.get(id));
      expect(v2Only.decrypt(context(row), row.value), id).toBe(plaintexts.get(id));
      expect(() => v1Only.decrypt(context(row), row.value), id).toThrow();
    }
    const secret = await ownerSecret();
    expect(secret).not.toBe(mfaOriginal);
    expect(sealed(`2:${M2}`, 2).versionOf(secret)).toBe(2);
    await expect(sealed(M1).open(secret, `totp:${ownerUserId}`)).rejects.toThrow();

    const v2 = await appWith({
      FIELD_ENCRYPTION_KEYS: `2:${F2}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: 2,
      AUTH_MFA_ENCRYPTION_KEY: `2:${M2}`,
      AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION: 2,
    });
    try {
      // The TOTP seed (now under version 2) still verifies codes; the ID still reveals.
      const browser = await signIn(v2);
      expect(await reveal(browser, labourerId)).toBe(plaintexts.get(labourer));
      // Payments read under version 2 alone: the callback URLs carry the same token, and every
      // credential is still configured.
      const token = [...plaintexts.entries()].find(([id]) =>
        id.startsWith("payment_callback_routes.token_enc."),
      )![1];
      const settings = await paymentSettings(browser);
      expect(settings.callbackUrls.every((entry) => entry.url.includes(`/hooks/${token}/`))).toBe(
        true,
      );
      expect(Object.values(settings.secrets).every((secret) => secret.configured)).toBe(true);
    } finally {
      await v2.close();
    }
  }, 300_000);

  it("lets only the schema owner rewrite a ciphertext, and nothing else on immutable rows", async () => {
    const cipher = fieldCipher(`1:${F1},2:${F2},3:${key("field v3")}`, 3);
    const [payout] = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.$queryRaw<{ id: string; value: Uint8Array }[]>`
        SELECT id::text AS id, account_number_enc AS value FROM supplier_payout_versions
         WHERE tenant_id = ${tenantId}::uuid AND account_number_enc IS NOT NULL LIMIT 1`;
    });
    expect(payout).toBeDefined();
    const rowContext = {
      tenantId,
      table: "supplier_payout_versions",
      column: "account_number_enc",
      rowId: payout!.id,
    };
    const next = cipher.reencrypt(rowContext, payout!.value);
    // A received payment callback (immutable evidence) and the company's payment credentials.
    const [callback] = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.$queryRaw<{ id: string; value: Uint8Array }[]>`
        SELECT id::text AS id, body_enc AS value FROM payment_callback_inbox
         WHERE tenant_id = ${tenantId}::uuid LIMIT 1`;
    });
    expect(callback).toBeDefined();
    const nextBody = cipher.reencrypt(
      { tenantId, table: "payment_callback_inbox", column: "body_enc", rowId: callback!.id },
      callback!.value,
    );
    const [credentials] = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.$queryRaw<{ key: Uint8Array; secret: Uint8Array }[]>`
        SELECT consumer_key_enc AS key, consumer_secret_enc AS secret FROM payment_settings
         WHERE tenant_id = ${tenantId}::uuid`;
    });
    const settingsContext = (column: string) => ({
      tenantId,
      table: "payment_settings",
      column,
      rowId: tenantId,
    });
    const nextKey = cipher.reencrypt(settingsContext("consumer_key_enc"), credentials!.key);
    const nextSecret = cipher.reencrypt(
      settingsContext("consumer_secret_enc"),
      credentials!.secret,
    );

    // The runtime role meets the original guard, even for a pure re-encryption.
    const runtime = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().appUrl }),
    });
    try {
      await expect(
        runtime.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await tx.$executeRaw`UPDATE supplier_payout_versions SET account_number_enc = ${next}
            WHERE tenant_id = ${tenantId}::uuid AND id = ${payout!.id}::uuid`;
        }),
      ).rejects.toThrow(/never change/);
      await expect(
        runtime.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await tx.$executeRaw`UPDATE do_not_rehire_events SET reason_enc = reason_enc
            WHERE tenant_id = ${tenantId}::uuid`;
        }),
      ).rejects.toThrow(/permission denied|append-only/);
      await expect(
        runtime.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await tx.$executeRaw`UPDATE payment_callback_inbox SET body_enc = ${nextBody}
            WHERE tenant_id = ${tenantId}::uuid AND id = ${callback!.id}::uuid`;
        }),
      ).rejects.toThrow(/immutable/);
    } finally {
      await runtime.$disconnect();
    }

    // The owner cannot slip another change in with a re-encryption.
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`UPDATE supplier_payout_versions
          SET account_number_enc = ${next}, account_name = 'Someone else'
          WHERE tenant_id = ${tenantId}::uuid AND id = ${payout!.id}::uuid`;
      }),
    ).rejects.toThrow(/never change/);
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`UPDATE payment_callback_inbox
          SET body_enc = ${nextBody}, redacted_body = '{}'::jsonb
          WHERE tenant_id = ${tenantId}::uuid AND id = ${callback!.id}::uuid`;
      }),
    ).rejects.toThrow(/immutable/);
    // One re-encryption per update: two credentials at once meet the settings guard.
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`UPDATE payment_settings
          SET consumer_key_enc = ${nextKey}, consumer_secret_enc = ${nextSecret}
          WHERE tenant_id = ${tenantId}::uuid`;
      }),
    ).rejects.toThrow(/next version/);
    // …nor rewrite a value under the same key version.
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`UPDATE do_not_rehire_events SET reason_enc = reason_enc
          WHERE tenant_id = ${tenantId}::uuid`;
      }),
    ).rejects.toThrow(/append-only/);
  });
});
