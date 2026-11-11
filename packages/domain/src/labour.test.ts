import { describe, expect, it } from "vitest";
import { ageOn } from "./age.js";
import {
  accreditationStatus,
  addCalendarDays,
  calendarDaysBetween,
  isOldEnoughToRegister,
  latestAllowedBirthDate,
  identityIndexValue,
  isIdentifierSearch,
  maskIdentifier,
  normaliseIdNumber,
  normaliseKraPin,
  normaliseStatutoryNumber,
  rateEffectiveTo,
  rateKey,
  rateScopeOf,
  resolveRate,
  summariseAccreditation,
  type RateCandidate,
} from "./labour.js";

describe("calendar arithmetic", () => {
  it("adds days across month, year and leap-day boundaries", () => {
    expect(addCalendarDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2026-11-11", -11)).toBe("2026-10-31");
    expect(calendarDaysBetween("2026-11-11", "2026-12-11")).toBe(30);
    expect(calendarDaysBetween("2026-11-11", "2026-11-01")).toBe(-10);
  });
});

describe("minimum age on the registration date", () => {
  it("allows the 18th birthday itself and refuses one day short", () => {
    expect(isOldEnoughToRegister("2008-11-11", "2026-11-11")).toBe(true);
    expect(isOldEnoughToRegister("2008-11-12", "2026-11-11")).toBe(false);
    expect(latestAllowedBirthDate("2026-11-11")).toBe("2008-11-11");
  });

  it("treats leap-day births like PostgreSQL's date - interval '18 years'", () => {
    // 28/02/2026 − 18 years = 28/02/2008: someone born 29/02/2008 is still 17.
    expect(latestAllowedBirthDate("2026-02-28")).toBe("2008-02-28");
    expect(isOldEnoughToRegister("2008-02-29", "2026-02-28")).toBe(false);
    expect(isOldEnoughToRegister("2008-02-29", "2026-03-01")).toBe(true);
    // On 29/02/2028 the limit is 28/02/2010 (2010 has no 29 February).
    expect(latestAllowedBirthDate("2028-02-29")).toBe("2010-02-28");
    expect(isOldEnoughToRegister("2010-02-28", "2028-02-29")).toBe(true);
    expect(isOldEnoughToRegister("2010-03-01", "2028-02-29")).toBe(false);
    // A leap-day birth registering on a leap-day birthday.
    expect(isOldEnoughToRegister("2012-02-29", "2030-02-28")).toBe(false);
    expect(isOldEnoughToRegister("2012-02-29", "2030-03-01")).toBe(true);
  });

  it("agrees with ageOn for every day of two years around a leap year", () => {
    const births = ["2008-02-29", "2008-02-28", "2008-03-01", "2008-12-31", "2009-01-01"];
    for (let day = 0; day < 730; day += 1) {
      const onDate = addCalendarDays("2026-01-01", day);
      for (const birth of births)
        expect(isOldEnoughToRegister(birth, onDate), `${birth} on ${onDate}`).toBe(
          ageOn(birth, onDate) >= 18,
        );
    }
  });

  it("rejects malformed dates", () => {
    expect(() => isOldEnoughToRegister("11/11/2008", "2026-11-11")).toThrow(TypeError);
  });
});

describe("NCA accreditation expiry", () => {
  it("is valid, expiring within the lead time, or expired after the expiry date", () => {
    expect(accreditationStatus("2026-12-12", "2026-11-11", 30)).toBe("valid");
    expect(accreditationStatus("2026-12-11", "2026-11-11", 30)).toBe("expiring");
    expect(accreditationStatus("2026-11-11", "2026-11-11", 30)).toBe("expiring");
    expect(accreditationStatus("2026-11-10", "2026-11-11", 30)).toBe("expired");
    expect(accreditationStatus("2026-11-20", "2026-11-11", 7)).toBe("valid");
  });

  it("summarises a labourer by the card that expires last", () => {
    expect(
      summariseAccreditation(
        [{ expiresOn: "2026-10-01" }, { expiresOn: "2027-10-01" }],
        true,
        "2026-11-11",
        30,
      ),
    ).toEqual({ status: "valid", expiresOn: "2027-10-01", daysLeft: 324 });
    expect(summariseAccreditation([{ expiresOn: "2026-11-01" }], true, "2026-11-11", 30)).toEqual({
      status: "expired",
      expiresOn: "2026-11-01",
      daysLeft: -10,
    });
    expect(summariseAccreditation([], true, "2026-11-11", 30).status).toBe("missing");
    expect(summariseAccreditation([], false, "2026-11-11", 30).status).toBe("not_required");
  });
});

describe("identifier normalisation and masking", () => {
  it("normalises national IDs, passports, KRA PINs and statutory numbers", () => {
    expect(normaliseIdNumber("national_id", " 2345 6789 ")).toBe("23456789");
    expect(normaliseIdNumber("national_id", "12-345-678")).toBe("12345678");
    expect(normaliseIdNumber("national_id", "AB123456")).toBeNull();
    expect(normaliseIdNumber("national_id", "123")).toBeNull();
    expect(normaliseIdNumber("passport", "ak 0123456")).toBe("AK0123456");
    expect(normaliseIdNumber("passport", "ABCDEFGH")).toBeNull();
    expect(normaliseIdNumber("alien_id", "a-123456")).toBe("A123456");
    expect(normaliseKraPin("a012345678z")).toBe("A012345678Z");
    expect(normaliseKraPin("B012345678Z")).toBeNull();
    expect(normaliseStatutoryNumber("nssf 2001 9934")).toBe("NSSF20019934");
    expect(normaliseStatutoryNumber("ABC")).toBeNull();
  });

  it("indexes an identity number independently of its document type", () => {
    // Review finding: the same digits under another document type must be the same identity.
    for (const type of ["national_id", "alien_id", "passport"] as const)
      expect(identityIndexValue(normaliseIdNumber(type, "23456789")!)).toBe("23456789");
    expect(identityIndexValue("023456789")).toBe("23456789");
    expect(identityIndexValue("0-2345-6789")).toBe("23456789");
    expect(identityIndexValue("ak 0123456")).toBe("AK0123456");
    expect(identityIndexValue("12")).toBeNull();
    expect(identityIndexValue("ABCDEFGH")).toBeNull();
  });

  it("treats any search term with a digit, except a worker number, as an identifier", () => {
    expect(isIdentifierSearch("23456789")).toBe(true);
    expect(isIdentifierSearch("0712 345 678")).toBe(true);
    expect(isIdentifierSearch("A012345678Z")).toBe(true);
    expect(isIdentifierSearch("Grace 2")).toBe(true);
    expect(isIdentifierSearch("WRK-0012")).toBe(false);
    expect(isIdentifierSearch("wrk 12")).toBe(false);
    expect(isIdentifierSearch("Grace Atieno")).toBe(false);
  });

  it("masks all but the last three characters", () => {
    expect(maskIdentifier("23456789")).toBe("•••••789");
    expect(maskIdentifier("A012345678Z")).toBe("•••••78Z");
  });
});

describe("effective-dated rates", () => {
  const rate = (fields: Partial<RateCandidate> & Pick<RateCandidate, "id">): RateCandidate => ({
    projectId: null,
    labourerId: null,
    tradeId: "mason",
    skillLevelId: null,
    basis: "daily",
    rateMinor: 100_000,
    effectiveFrom: "2026-01-01",
    ...fields,
  });
  const rates = [
    rate({ id: "company-mason", rateMinor: 120_000 }),
    rate({ id: "company-mason-new", rateMinor: 130_000, effectiveFrom: "2026-12-01" }),
    rate({ id: "company-mason-skilled", skillLevelId: "skilled", rateMinor: 150_000 }),
    rate({ id: "project-mason", projectId: "rui", rateMinor: 140_000 }),
    rate({ id: "project-mason-hourly", projectId: "rui", basis: "hourly", rateMinor: 18_000 }),
    rate({
      id: "labourer",
      projectId: "rui",
      labourerId: "wanjiku",
      tradeId: null,
      rateMinor: 170_000,
      effectiveFrom: "2026-06-01",
    }),
  ];
  const query = {
    onDate: "2026-11-11",
    basis: "daily" as const,
    projectId: "rui",
    labourerId: "otieno",
    tradeId: "mason",
    skillLevelId: "skilled",
  };

  it("classifies scopes and keys", () => {
    expect(rates.map((entry) => rateScopeOf(entry))).toEqual([
      "company_trade",
      "company_trade",
      "company_skill",
      "project_trade",
      "project_trade",
      "labourer",
    ]);
    expect(rateKey(rates[0]!)).toBe("-|-|mason|-|daily");
    expect(rateKey(rates[5]!)).toBe("rui|wanjiku|-|-|daily");
  });

  it("prefers the most specific scope, then the latest row in force", () => {
    expect(resolveRate(rates, query)?.rate.id).toBe("project-mason");
    expect(resolveRate(rates, { ...query, labourerId: "wanjiku" })).toMatchObject({
      rate: { id: "labourer" },
      scope: "labourer",
    });
    expect(
      resolveRate(rates, { ...query, labourerId: "wanjiku", onDate: "2026-05-31" })?.rate.id,
    ).toBe("project-mason");
    expect(resolveRate(rates, { ...query, projectId: "kit" })?.rate.id).toBe(
      "company-mason-skilled",
    );
    expect(resolveRate(rates, { ...query, projectId: "kit", skillLevelId: null })?.rate.id).toBe(
      "company-mason",
    );
    expect(
      resolveRate(rates, { ...query, projectId: "kit", skillLevelId: null, onDate: "2026-12-01" })
        ?.rate.id,
    ).toBe("company-mason-new");
    expect(resolveRate(rates, { ...query, basis: "hourly" })?.rate.rateMinor).toBe(18_000);
    expect(resolveRate(rates, { ...query, tradeId: "plumber", projectId: "kit" })).toBeNull();
    expect(resolveRate(rates, { ...query, onDate: "2025-12-31" })).toBeNull();
  });

  it("never rewrites history: a new row ends the previous one the day before", () => {
    expect(rateEffectiveTo(rates[0]!, rates)).toBe("2026-11-30");
    expect(rateEffectiveTo(rates[1]!, rates)).toBeNull();
    expect(rateEffectiveTo(rates[3]!, rates)).toBeNull();
  });
});
