import { describe, expect, it } from "vitest";
import {
  correctiveActionActionRequestSchema,
  createCorrectiveActionRequestSchema,
  createInductionRequestSchema,
  regulatorDecisionRequestSchema,
  reportIncidentRequestSchema,
  updateSafetySettingsRequestSchema,
} from "./safety.js";
import { DEFAULT_PPE_REPLACEMENT_DAYS } from "@pm-buddy/types";

const id = "31000000-0000-4000-8000-000000000001";
const other = "31000000-0000-4000-8000-000000000002";

describe("health and safety contracts", () => {
  it("names exactly one person for an induction, matching its kind", () => {
    const base = {
      siteId: id,
      inductedOn: "2026-11-10",
      inductorId: other,
      topics: ["site_rules", "ppe"],
      acknowledgement: "signed",
    };
    expect(
      createInductionRequestSchema.safeParse({ ...base, personKind: "labourer", labourerId: id })
        .success,
    ).toBe(true);
    expect(
      createInductionRequestSchema.safeParse({
        ...base,
        personKind: "visitor",
        visitorName: "  Eng. Synthetic Visitor ",
        visitorOrganisation: "County",
      }).data?.visitorName,
    ).toBe("Eng. Synthetic Visitor");
    for (const bad of [
      { personKind: "labourer" },
      { personKind: "labourer", userId: id },
      { personKind: "staff", userId: id, labourerId: id },
      { personKind: "labourer", labourerId: id, visitorOrganisation: "Acme" },
      { personKind: "labourer", labourerId: id, topics: ["ppe", "ppe"] },
      { personKind: "labourer", labourerId: id, topics: [] },
      { personKind: "labourer", labourerId: id, inductedOn: "2100-01-01" },
    ])
      expect(createInductionRequestSchema.safeParse({ ...base, ...bad }).success).toBe(false);
  });

  it("requires an injured person (with coded injury fields only) for an injury, and none for a near miss", () => {
    const base = {
      siteId: id,
      kind: "injury",
      severity: "moderate",
      occurredAt: "2026-11-10T09:30:00+03:00",
      location: "Block A scaffold",
      description: "A labourer slipped on the second lift of the scaffold.",
      firstAidGiven: true,
    };
    const injured = { role: "injured", labourerId: id, injuryType: "sprain", bodyPart: "foot" };
    expect(reportIncidentRequestSchema.safeParse({ ...base, people: [injured] }).success).toBe(
      true,
    );
    expect(reportIncidentRequestSchema.safeParse({ ...base, people: [] }).success).toBe(false);
    expect(
      reportIncidentRequestSchema.safeParse({ ...base, kind: "near_miss", people: [injured] })
        .success,
    ).toBe(false);
    // Injury fields only for the injured; one reference per person; no duplicates.
    for (const people of [
      [{ ...injured, injuryType: undefined }],
      [
        injured,
        { role: "witness", name: "Synthetic Witness", injuryType: "cut", bodyPart: "hand" },
      ],
      [{ ...injured, name: "Also a name" }],
      [injured, injured],
    ])
      expect(reportIncidentRequestSchema.safeParse({ ...base, people }).success).toBe(false);
    expect(
      reportIncidentRequestSchema.safeParse({
        ...base,
        people: [injured],
        occurredAt: "2026-11-10",
      }).success,
    ).toBe(false);
  });

  it("records the regulator decision with a date when notified and a reason when not", () => {
    const parse = (value: object) =>
      regulatorDecisionRequestSchema.safeParse({ version: 1, ...value }).success;
    expect(parse({ decision: "notified", notifiedOn: "2026-11-11", reference: "DOSH/SYN/1" })).toBe(
      true,
    );
    expect(parse({ decision: "notified" })).toBe(false);
    expect(parse({ decision: "not_notifiable", reason: "No lost time; first aid only" })).toBe(
      true,
    );
    expect(parse({ decision: "not_notifiable" })).toBe(false);
    expect(parse({ decision: "not_notifiable", reason: "Minor", notifiedOn: "2026-11-11" })).toBe(
      false,
    );
  });

  it("ties a corrective action to exactly its source and asks reasons only to reject or cancel", () => {
    const base = { description: "Fit toe boards", ownerId: id, dueOn: "2026-11-20" };
    expect(
      createCorrectiveActionRequestSchema.safeParse({ ...base, source: "incident", incidentId: id })
        .success,
    ).toBe(true);
    expect(
      createCorrectiveActionRequestSchema.safeParse({ ...base, source: "other" }).success,
    ).toBe(true);
    expect(
      createCorrectiveActionRequestSchema.safeParse({ ...base, source: "incident" }).success,
    ).toBe(false);
    expect(
      createCorrectiveActionRequestSchema.safeParse({
        ...base,
        source: "other",
        inspectionId: id,
      }).success,
    ).toBe(false);
    const action = (value: object) =>
      correctiveActionActionRequestSchema.safeParse({ version: 2, ...value }).success;
    expect(action({ action: "done", note: "Toe boards fitted" })).toBe(true);
    expect(action({ action: "verify" })).toBe(true);
    expect(action({ action: "reject" })).toBe(false);
    expect(action({ action: "reject", reason: "Still missing on lift 3" })).toBe(true);
    expect(action({ action: "verify", reason: "x".repeat(10) })).toBe(false);
    expect(action({ action: "verify", note: "Looks fine" })).toBe(false);
  });

  it("validates the settings: unique topics, labels for the company's own topics, every PPE item", () => {
    const base = {
      inductionTopics: [
        { key: "site_rules", label: null },
        { key: "custom_dust", label: "Silica dust from cutting blocks" },
      ],
      inductionValidityDays: null,
      inductionLookbackDays: 14,
      kitCheckIntervalDays: 30,
      ppeReplacementDays: { ...DEFAULT_PPE_REPLACEMENT_DAYS },
      version: 0,
    };
    expect(updateSafetySettingsRequestSchema.safeParse(base).success).toBe(true);
    for (const bad of [
      { inductionTopics: [{ key: "custom_dust", label: null }] },
      { inductionTopics: [base.inductionTopics[0], base.inductionTopics[0]] },
      { inductionTopics: [] },
      { inductionValidityDays: 10 },
      { ppeReplacementDays: { helmet: 100 } },
      { ppeReplacementDays: { ...DEFAULT_PPE_REPLACEMENT_DAYS, gloves: 0 } },
    ])
      expect(updateSafetySettingsRequestSchema.safeParse({ ...base, ...bad }).success).toBe(false);
  });
});
