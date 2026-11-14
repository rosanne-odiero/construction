import { describe, expect, it } from "vitest";
import {
  approvalResponseRequestSchema,
  createDocumentFieldsSchema,
  recordComplianceRequestSchema,
  recordInstructionRequestSchema,
} from "./documents.js";

const id = "31000000-0000-4000-8000-000000000001";
const sha256 = "a".repeat(64);

describe("documents contracts", () => {
  it("needs a drawing number and discipline for drawings only, and treats empty fields as absent", () => {
    expect(
      createDocumentFieldsSchema.safeParse({
        category: "drawing",
        title: "Ground floor plan",
        revision: "P1",
        drawingNumber: "",
        discipline: "",
      }).success,
    ).toBe(false);
    const permit = createDocumentFieldsSchema.parse({
      category: "permit",
      title: "County approval",
      revision: "1",
      reference: "",
      changeNote: "",
    });
    expect(permit).toMatchObject({ category: "permit", revision: "1" });
    expect(permit.reference).toBeUndefined();
    expect(
      createDocumentFieldsSchema.safeParse({
        category: "permit",
        title: "County approval",
        revision: "1",
        drawingNumber: "A-101",
      }).success,
    ).toBe(false);
    expect(
      createDocumentFieldsSchema.safeParse({ category: "other", title: "Note", revision: "../1" })
        .success,
    ).toBe(false);
  });

  it("records not applicable with a reason and nothing else", () => {
    const base = { typeId: id, supersedesId: null };
    expect(
      recordComplianceRequestSchema.safeParse({
        ...base,
        kind: "not_applicable",
        reason: "Below the EIA threshold",
      }).success,
    ).toBe(true);
    expect(
      recordComplianceRequestSchema.safeParse({ ...base, kind: "not_applicable" }).success,
    ).toBe(false);
    expect(
      recordComplianceRequestSchema.safeParse({
        ...base,
        kind: "not_applicable",
        reason: "Below the EIA threshold",
        expiresOn: "2027-01-01",
      }).success,
    ).toBe(false);
    expect(
      recordComplianceRequestSchema.safeParse({ ...base, kind: "record", reason: "Why" }).success,
    ).toBe(false);
  });

  it("refuses an instruction received before it was issued", () => {
    const instruction = {
      id,
      number: "AI-001",
      kind: "architect_instruction",
      issuerName: "Arch. Njeri",
      issuerRole: "architect",
      issuedOn: "2026-11-10",
      receivedOn: "2026-11-09",
      subject: "Balustrade",
    };
    expect(recordInstructionRequestSchema.safeParse(instruction).success).toBe(false);
    expect(
      recordInstructionRequestSchema.parse({ ...instruction, receivedOn: "2026-11-10" }),
    ).toMatchObject({ costImplication: false, issuedByMe: false });
  });

  it("needs the consultant's name and the scan for a paper response, and comments unless approved", () => {
    const answer = {
      decision: "approved",
      respondedOn: "2026-11-10",
      documentSha256: sha256,
      version: 1,
    };
    expect(approvalResponseRequestSchema.safeParse({ ...answer, channel: "in_app" }).success).toBe(
      true,
    );
    expect(approvalResponseRequestSchema.safeParse({ ...answer, channel: "paper" }).success).toBe(
      false,
    );
    expect(
      approvalResponseRequestSchema.safeParse({
        ...answer,
        channel: "paper",
        responderName: "Arch. Njeri",
        evidenceVersionId: id,
      }).success,
    ).toBe(true);
    expect(
      approvalResponseRequestSchema.safeParse({
        ...answer,
        channel: "in_app",
        responderName: "Someone else",
      }).success,
    ).toBe(false);
    expect(
      approvalResponseRequestSchema.safeParse({
        ...answer,
        channel: "in_app",
        decision: "rejected",
      }).success,
    ).toBe(false);
  });
});
