import { describe, expect, it } from "vitest";
import {
  apiEnvSchema,
  createLabourRateRequestSchema,
  labourerListQuerySchema,
  labourerLookupRequestSchema,
  labourerSummarySchema,
  labourRegistryFiltersSchema,
  labourViewFiltersSchema,
  registerLabourerRequestSchema,
  revealResponseSchema,
  updateLabourerRequestSchema,
  withdrawConsentRequestSchema,
} from "./index.js";

const tradeId = "40000000-0000-4000-8000-000000000001";
const skillLevelId = "40000000-0000-4000-8000-000000000002";
const registration = {
  fullName: "  Wanjiku Test Kamau ",
  dateOfBirth: "1990-05-17",
  gender: "female",
  tradeId,
  skillLevelId,
  engagementType: "casual",
  rateBasis: "daily",
  idType: "national_id",
  idNumber: "9000 0001",
  phone: "0700 000 001",
  kraPin: "a900000001z",
  consent: {
    noticeVersion: "registration-2026-11-v1",
    language: "sw",
    method: "witnessed_verbal",
    witnessName: "Kevin Kiprono",
    granted: true,
  },
};
const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

describe("labourer registration", () => {
  it("normalises identifiers into the canonical form the blind index uses", () => {
    const parsed = registerLabourerRequestSchema.parse(registration);
    expect(parsed).toMatchObject({
      fullName: "Wanjiku Test Kamau",
      idNumber: "90000001",
      phone: "254700000001",
      kraPin: "A900000001Z",
    });
  });

  it("refuses unknown fields, invalid identifiers and consent without a witness or refusal", () => {
    expect(
      registerLabourerRequestSchema.safeParse({ ...registration, tenantId: tradeId }).success,
    ).toBe(false);
    expect(
      messages(registerLabourerRequestSchema.safeParse({ ...registration, idNumber: "AB12" })),
    ).toContain("invalid_id_number");
    expect(
      messages(registerLabourerRequestSchema.safeParse({ ...registration, kraPin: "12345" })),
    ).toContain("invalid_kra_pin");
    expect(
      messages(
        registerLabourerRequestSchema.safeParse({
          ...registration,
          consent: { ...registration.consent, witnessName: undefined },
        }),
      ),
    ).toContain("witness_required");
    expect(
      registerLabourerRequestSchema.safeParse({
        ...registration,
        consent: { ...registration.consent, granted: false },
      }).success,
    ).toBe(false);
    expect(
      registerLabourerRequestSchema.safeParse({
        ...registration,
        consent: { ...registration.consent, noticeVersion: "made-up" },
      }).success,
    ).toBe(false);
  });

  it("treats empty optional identifiers as not recorded", () => {
    const parsed = registerLabourerRequestSchema.parse({
      ...registration,
      phone: "",
      kraPin: null,
    });
    expect(parsed.phone).toBeNull();
    expect(parsed.kraPin).toBeNull();
  });

  it("changes identity documents only as a pair and needs a change", () => {
    expect(messages(updateLabourerRequestSchema.safeParse({ version: 1 }))).toContain("no_changes");
    expect(
      messages(updateLabourerRequestSchema.safeParse({ version: 1, idNumber: "90000002" })),
    ).toContain("identity_incomplete");
    expect(
      updateLabourerRequestSchema.parse({ version: 2, idType: "passport", idNumber: "ak 1234567" })
        .idNumber,
    ).toBe("AK1234567");
    expect(
      messages(withdrawConsentRequestSchema.safeParse({ method: "witnessed_verbal" })),
    ).toContain("witness_required");
  });
});

describe("labour rates", () => {
  it("needs a trade for company and project rates, and a project for a labourer's own rate", () => {
    expect(
      createLabourRateRequestSchema.safeParse({
        tradeId,
        basis: "daily",
        rateMinor: 150_000,
        effectiveFrom: "2026-11-11",
      }).success,
    ).toBe(true);
    expect(
      messages(
        createLabourRateRequestSchema.safeParse({
          basis: "daily",
          rateMinor: 150_000,
          effectiveFrom: "2026-11-11",
        }),
      ),
    ).toContain("trade_required");
    expect(
      messages(
        createLabourRateRequestSchema.safeParse({
          labourerId: tradeId,
          tradeId,
          basis: "daily",
          rateMinor: 150_000,
          effectiveFrom: "2026-11-11",
        }),
      ),
    ).toEqual(expect.arrayContaining(["project_required", "labourer_rate_has_no_trade"]));
    expect(
      createLabourRateRequestSchema.safeParse({
        tradeId,
        basis: "daily",
        rateMinor: 1500.5,
        effectiveFrom: "2026-11-11",
      }).success,
    ).toBe(false);
  });
});

describe("registry queries and responses", () => {
  it("coerces paging and keeps saved-view filters strict", () => {
    expect(labourerListQuerySchema.parse({ limit: "25", doNotRehire: "true" })).toMatchObject({
      limit: 25,
      offset: 0,
      doNotRehire: "true",
    });
    expect(labourViewFiltersSchema.safeParse({ limit: 10 }).success).toBe(false);
    expect(labourViewFiltersSchema.parse({ accreditation: "attention" })).toEqual({
      accreditation: "attention",
    });
  });

  it("keeps identifiers out of URLs and saved views", () => {
    // Names and worker numbers may travel in the registry URL; anything with digits may not.
    expect(labourerListQuerySchema.parse({ search: "Grace" }).search).toBe("Grace");
    expect(labourerListQuerySchema.parse({ search: "WRK-0012" }).search).toBe("WRK-0012");
    for (const search of ["23456789", "0712345678", "A012345678Z"])
      expect(labourerListQuerySchema.safeParse({ search }).success, search).toBe(false);
    expect(labourRegistryFiltersSchema.safeParse({ search: "23456789" }).success).toBe(false);
    // A saved view never stores search text at all.
    expect(labourViewFiltersSchema.safeParse({ search: "Grace" }).success).toBe(false);
    expect(labourerLookupRequestSchema.parse({ identifier: " 2345 6789 " })).toEqual({
      identifier: "2345 6789",
    });
    expect(labourerLookupRequestSchema.safeParse({ identifier: "1" }).success).toBe(false);
  });

  it("accepts only masked identifiers in a registry row", () => {
    const row = {
      id: tradeId,
      workerNo: "WRK-0001",
      fullName: "Wanjiku Test Kamau",
      status: "active",
      gender: "female",
      trade: null,
      skillLevel: null,
      engagementType: "casual",
      rateBasis: "daily",
      projects: [],
      gang: null,
      accreditation: { status: "not_required", expiresOn: null, daysLeft: null },
      consent: { status: "granted", noticeVersion: "registration-2026-11-v1", current: true },
      idType: "national_id",
      idNumberMasked: "•••••001",
      phoneMasked: "2547•••••001",
      doNotRehire: null,
      registeredOn: "2026-11-11",
    };
    expect(labourerSummarySchema.safeParse(row).success).toBe(true);
    expect(labourerSummarySchema.safeParse({ ...row, idNumberMasked: "90000001" }).success).toBe(
      false,
    );
    expect(
      revealResponseSchema.safeParse({
        field: "nextOfKin",
        value: { name: "Jane", relationship: "Sister", phone: null },
        revealedAt: "2026-11-11T08:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("field encryption settings", () => {
  const base = {
    DATABASE_URL: "postgresql://pmb_app:x@localhost:55432/pmb",
    REDIS_URL: "redis://localhost:56379",
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "pmb-local",
    S3_ACCESS_KEY_ID: "pmbdev",
    S3_SECRET_ACCESS_KEY: "pmbdevsecret",
  };
  const key = "a".repeat(64);

  it("accepts versioned key lists and a separate blind-index key", () => {
    const env = apiEnvSchema.parse({
      ...base,
      FIELD_ENCRYPTION_KEYS: `1:${key}, 2:${"b".repeat(64)}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: "2",
      FIELD_BLIND_INDEX_KEY: "c".repeat(64),
    });
    expect(env.FIELD_ENCRYPTION_ACTIVE_KEY_VERSION).toBe(2);
  });

  it("refuses malformed keys", () => {
    expect(apiEnvSchema.safeParse({ ...base, FIELD_ENCRYPTION_KEYS: key }).success).toBe(false);
    expect(apiEnvSchema.safeParse({ ...base, FIELD_ENCRYPTION_KEYS: "1:abc" }).success).toBe(false);
    expect(apiEnvSchema.safeParse({ ...base, FIELD_BLIND_INDEX_KEY: "xyz" }).success).toBe(false);
  });
});
