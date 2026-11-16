import { existsSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { validateEnv } from "../config/app-config.js";
import { PrismaClient } from "../generated/prisma/client.js";
import {
  parseTemplateKeyList,
  TemplateOpener,
  TemplateSealer,
} from "../modules/biometrics/template-sealer.js";
import { parseSealKeys, SealedSecrets } from "../modules/identity/sealed-secrets.js";
import { FieldCipher, parseFieldKeys } from "../modules/labour/field-cipher.js";
import { parseArgs, USAGE } from "./cli-args.js";
import { KeyRotation, type RunSummary } from "./key-rotation.js";

/**
 * `pnpm --filter @pm-buddy/api keys:rotate <command>` (D9.1, docs/OPERATIONS.md "Key rotation").
 *
 *   status                         stored values per key version (field, TOTP seeds, PIN pepper)
 *   rewrap --operator "<name>"     re-encrypt field values and TOTP seeds onto the active keys
 *     [--only field|mfa|biometric] [--tenant <company ID>] [--batch <rows>] [--dry-run]
 *
 * Biometric templates (D3.4) are re-sealed only with `--only biometric`: that needs the operator's
 * BIOMETRIC_TEMPLATE_PRIVATE_KEYS (`<version>:<64 hex>` X25519 private keys, set for this run
 * only, never in the API's environment) besides BIOMETRIC_TEMPLATE_PUBLIC_KEYS.
 *
 * Reads the same key variables as the API (FIELD_ENCRYPTION_KEYS, FIELD_ENCRYPTION_ACTIVE_KEY_VERSION,
 * FIELD_BLIND_INDEX_KEY, AUTH_MFA_ENCRYPTION_KEY, AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION) and
 * connects with DATABASE_MIGRATION_URL as the schema owner. Prints counts only, never values.
 */
function print(summary: RunSummary): void {
  console.log(
    `${summary.kind} → key version ${summary.targetVersion}${summary.dryRun ? " (dry run: nothing written)" : ""}: ` +
      `${summary.checked} on an older key, ${summary.rewrapped} re-encrypted, ${summary.failed} unreadable — ${summary.status} (run ${summary.runId})`,
  );
  for (const reference of summary.failures) console.log(`  unreadable: ${reference}`);
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  // Same rule as the API and prisma.config.ts: `.env`, then `.env.example`, outside production.
  // Variables already set in the environment win (process.loadEnvFile never overwrites them).
  if (process.env["NODE_ENV"] !== "production")
    for (const file of [".env", ".env.example"]) if (existsSync(file)) process.loadEnvFile(file);
  const env = validateEnv(process.env);
  const url = z.url().safeParse(process.env["DATABASE_MIGRATION_URL"]);
  if (!url.success) {
    console.error("DATABASE_MIGRATION_URL (the schema owner) is required");
    return 2;
  }
  const field = env.FIELD_ENCRYPTION_KEYS
    ? new FieldCipher(
        parseFieldKeys(
          env.FIELD_ENCRYPTION_KEYS,
          env.FIELD_ENCRYPTION_ACTIVE_KEY_VERSION,
          env.FIELD_BLIND_INDEX_KEY,
        ),
      )
    : undefined;
  const sealKeys = parseSealKeys(
    env.AUTH_MFA_ENCRYPTION_KEY,
    env.AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION,
  );
  const publicKeys = env.BIOMETRIC_TEMPLATE_PUBLIC_KEYS
    ? parseTemplateKeyList(
        "BIOMETRIC_TEMPLATE_PUBLIC_KEYS",
        env.BIOMETRIC_TEMPLATE_PUBLIC_KEYS,
        env.BIOMETRIC_TEMPLATE_ACTIVE_KEY_VERSION,
      )
    : undefined;
  const privateKeys = process.env["BIOMETRIC_TEMPLATE_PRIVATE_KEYS"];
  const biometric =
    publicKeys && privateKeys
      ? {
          sealer: new TemplateSealer(publicKeys.keys, publicKeys.activeVersion),
          opener: new TemplateOpener(
            parseTemplateKeyList("BIOMETRIC_TEMPLATE_PRIVATE_KEYS", privateKeys).keys,
          ),
        }
      : undefined;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.data }) });
  const rotation = new KeyRotation(
    db,
    { field, sealed: sealKeys ? new SealedSecrets(sealKeys) : undefined, biometric },
    (line) => console.log(`  ${line}`),
  );
  try {
    await rotation.assertOwner();
    if (args.command === "status") {
      const status = {
        activeVersions: {
          field: field?.activeVersion ?? null,
          mfa: sealKeys?.active ?? null,
          pinPepper:
            env.AUTH_PIN_PEPPER_ACTIVE_VERSION ??
            (env.AUTH_PIN_PEPPER_KEYS?.split(",").length === 1
              ? Number(env.AUTH_PIN_PEPPER_KEYS.split(":")[0])
              : null),
          biometric: publicKeys?.activeVersion ?? null,
        },
        field: await rotation.fieldStatus(args.tenant),
        mfa: sealKeys ? await rotation.mfaStatus(args.tenant) : {},
        pinPepper: await rotation.pinStatus(),
        biometric: await rotation.biometricStatus(args.tenant),
      };
      console.log(JSON.stringify(status, null, 2));
      return 0;
    }
    const options = {
      operator: args.operator!,
      tenantId: args.tenant,
      batchSize: args.batch,
      dryRun: args.dryRun,
    };
    let failed = 0;
    if (args.only === "biometric") {
      const summary = await rotation.rewrapBiometric(options);
      print(summary);
      return summary.failed ? 1 : 0;
    }
    if (args.only !== "mfa") {
      const summary = await rotation.rewrapFields(options);
      print(summary);
      failed += summary.failed;
    }
    if (args.only !== "field") {
      const summary = await rotation.rewrapMfa(options);
      print(summary);
      failed += summary.failed;
    }
    return failed ? 1 : 0;
  } catch (error) {
    console.error(`keys:rotate failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

process.exitCode = await main();
