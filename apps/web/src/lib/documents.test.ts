import { describe, expect, it } from "vitest";
import {
  complianceTypeLabel,
  documentsAccess,
  downloadHref,
  exportHref,
  fileTooLarge,
  formatBytes,
  instructionRetryPlan,
  projectTabHref,
  reminderHref,
} from "./documents";
import { FoundationApiError } from "./foundation-api";

describe("documents access (D-110, D-112)", () => {
  it("reads with a document read permission and sees commercial documents with finance.view", () => {
    expect(documentsAccess(["projects.view", "site.diary"])).toEqual({
      read: true,
      confidential: false,
      manage: false,
      recordInstruction: true,
      manageInstruction: false,
    });
    expect(documentsAccess(["projects.view", "documents.manage", "finance.view"])).toMatchObject({
      read: true,
      confidential: true,
      manage: true,
      manageInstruction: true,
    });
  });

  it("refuses clients, storekeepers and anyone without projects.view", () => {
    expect(documentsAccess(["projects.view", "bq.view", "portal.client"]).read).toBe(false);
    expect(documentsAccess(["projects.view", "stores.manage"]).read).toBe(false);
    expect(documentsAccess(["documents.manage"]).manage).toBe(false);
  });
});

describe("document helpers", () => {
  it("formats sizes and the 25 MB limit", () => {
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(14_540)).toBe("14.2 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(fileTooLarge(25 * 1024 * 1024)).toBe(false);
    expect(fileTooLarge(25 * 1024 * 1024 + 1)).toBe(true);
  });

  it("builds same-origin links", () => {
    expect(downloadHref("p", "d", "v")).toBe("/api/v1/projects/p/documents/d/versions/v/content");
    expect(exportHref("p", "xlsx", "sw")).toBe(
      "/api/v1/projects/p/compliance/export/xlsx?locale=sw",
    );
    expect(projectTabHref("p", "documents", { view: "drawings", search: "", cursor: 30 })).toBe(
      "/projects/p?tab=documents&view=drawings&cursor=30",
    );
  });

  it("keeps the record ID and key unless a refusal recorded nothing", () => {
    expect(instructionRetryPlan(new FoundationApiError(409, "idempotency-key-reused"))).toBe(
      "recorded",
    );
    expect(instructionRetryPlan(new FoundationApiError(409, "instruction-id-conflict"))).toBe(
      "recorded",
    );
    expect(instructionRetryPlan(new FoundationApiError(409, "instruction-number-taken"))).toBe(
      "renew",
    );
    expect(instructionRetryPlan(new FoundationApiError(0, "network"))).toBe("keep");
    expect(instructionRetryPlan(new FoundationApiError(503, "requestFailed"))).toBe("keep");
    expect(instructionRetryPlan(new Error("boom"))).toBe("keep");
  });
});

describe("compliance labels and reminder links", () => {
  const translate = (key: string) => `t:${key}`;
  it("translates starter types and keeps the company's own names", () => {
    expect(complianceTypeLabel({ key: "wiba_insurance", label: null }, translate)).toBe(
      "t:complianceTypes.wiba_insurance",
    );
    expect(complianceTypeLabel({ key: "custom_1", label: "Hoarding licence" }, translate)).toBe(
      "Hoarding licence",
    );
    expect(complianceTypeLabel({ key: "custom_2", label: null }, translate)).toBe("custom_2");
  });

  it("links project items, company items and overdue approvals", () => {
    const base = { project: { id: "p" }, type: { id: "t" }, approval: null };
    expect(reminderHref({ kind: "compliance_expiring", ...base })).toBe("/projects/p/compliance/t");
    expect(reminderHref({ kind: "compliance_expired", ...base, project: null })).toBe(
      "/documents/company/t",
    );
    expect(
      reminderHref({
        kind: "approval_overdue",
        project: { id: "p" },
        type: null,
        approval: { id: "a" },
      }),
    ).toBe("/projects/p/approvals/a");
    expect(reminderHref({ kind: "compliance_missing", ...base, type: null })).toBeNull();
  });
});
