import { describe, expect, it } from "vitest";
import { formatServerMessage } from "./index.js";

describe("server-side message rendering", () => {
  const notice = { company: "Mjenzi Bora", date: "16/11/2026" };

  it("renders in the recipient's language and falls back to English", () => {
    expect(formatServerMessage("sw", "payoutSms.numberChange.oldNumber", notice)).toBe(
      "Mjenzi Bora: namba ya M-Pesa ya kupokea mshahara wako ilibadilishwa tarehe 16/11/2026. Kama hukuomba mabadiliko haya, ijulishe ofisi ya eneo la kazi mara moja.",
    );
    const english = formatServerMessage("en", "payoutSms.numberChange.oldNumber", notice);
    expect(english).toMatch(/^Mjenzi Bora: the M-Pesa number for your wages was changed on 16\/11/);
    expect(formatServerMessage("fr", "payoutSms.numberChange.oldNumber", notice)).toBe(english);
    expect(formatServerMessage(undefined, "payoutSms.numberChange.oldNumber", notice)).toBe(
      english,
    );
    expect(formatServerMessage("en", "payoutSms.numberChange.subject")).toBe(
      "M-Pesa number changed",
    );
  });

  it("selects plural and select branches", () => {
    const subject = { batchReference: "PR-001/2026-11-09" };
    expect(formatServerMessage("sw", "payoutSms.approvalNotice.subject", subject)).toBe(
      "Mishahara imeidhinishwa: PR-001/2026-11-09",
    );
    const values = {
      company: "Mjenzi Bora",
      batchReference: "PR-001",
      project: "Kilimani Heights",
      periodStart: "09/11/2026",
      periodEnd: "15/11/2026",
      net: "163,500",
      approver: "Achieng Otieno",
      approvedAt: "16/11/2026 10:30",
    };
    expect(
      formatServerMessage("en", "payoutSms.approvalNotice.text", { ...values, waiver: "yes" }),
    ).toContain("on 16/11/2026 10:30 under the segregation waiver.");
    expect(
      formatServerMessage("en", "payoutSms.approvalNotice.text", { ...values, waiver: "no" }),
    ).toContain("on 16/11/2026 10:30. If you did not expect");
  });

  it("refuses to render with a missing value or an unknown key", () => {
    expect(() =>
      formatServerMessage("en", "payoutSms.numberChange.oldNumber", { company: "Mjenzi Bora" }),
    ).toThrow();
    // @ts-expect-error only server message keys are accepted
    expect(() => formatServerMessage("en", "payoutSms.unknown", notice)).toThrow(
      "Unknown server message: payoutSms.unknown",
    );
  });
});
