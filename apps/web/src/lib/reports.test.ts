import { describe, expect, it } from "vitest";
import { REPORT_DEFINITIONS, REPORT_LIMITS } from "@pm-buddy/types";
import {
  cellText,
  defaultDates,
  exportHref,
  parseReportParams,
  pdfFits,
  reportQuery,
  wantsReport,
} from "./reports";

const PROJECT = "0194f0a2-7c1e-7d4b-9f00-1234567890ab";
const SITE = "0194f0a2-7c1e-7d4b-9f00-1234567890ac";

describe("reports centre", () => {
  it("keeps only the well-formed parameters the report takes", () => {
    expect(
      parseReportParams("muster-roll", {
        projectId: PROJECT,
        siteId: SITE,
        from: "2026-11-01",
        to: "not-a-date",
        storeId: PROJECT,
        locale: "sw",
      }),
    ).toEqual({ projectId: PROJECT, siteId: SITE, from: "2026-11-01" });
    expect(parseReportParams("audit-log", { projectId: PROJECT, action: "plant." })).toEqual({
      action: "plant.",
    });
    expect(parseReportParams("invoice-ageing", { asAt: "2026-11-14", from: "2026-11-01" })).toEqual(
      { asAt: "2026-11-14" },
    );
  });

  it("builds stable report and export links", () => {
    const params = { to: "2026-11-14", projectId: PROJECT, from: "2026-11-01" };
    expect(reportQuery(params)).toBe(`projectId=${PROJECT}&from=2026-11-01&to=2026-11-14`);
    expect(exportHref("cost-ledger", params, "xlsx", "sw")).toBe(
      `/api/v1/reports/cost-ledger/export/xlsx?projectId=${PROJECT}&from=2026-11-01&to=2026-11-14&locale=sw`,
    );
    expect(wantsReport({})).toBe(false);
    expect(wantsReport({ run: "1" })).toBe(true);
    expect(wantsReport({ projectId: PROJECT })).toBe(true);
  });

  it("offers the PDF up to the row limit only", () => {
    expect(pdfFits(REPORT_LIMITS.pdfMaxRows)).toBe(true);
    expect(pdfFits(REPORT_LIMITS.pdfMaxRows + 1)).toBe(false);
  });

  it("formats cells as on the other screens and shows unavailable values as a dash", () => {
    expect(cellText("money", 125_000_050)).toBe("KES 1,250,000.50");
    expect(cellText("money", -500_000)).toBe("\u2212KES 5,000");
    expect(cellText("date", "2028-02-29")).toBe("29/02/2028");
    expect(cellText("datetime", "2026-11-14T21:30:00.000Z")).toBe("15/11/2026 00:30");
    expect(cellText("quantity", "12345.5")).toBe("12,345.5");
    expect(cellText("percent", "79.9")).toBe("79.9 %");
    expect(cellText("money", null)).toBe("—");
    expect(cellText("text", "=SUM(A1)")).toBe("=SUM(A1)");
  });

  it("defaults the form's period to the report's days ending today", () => {
    expect(defaultDates(REPORT_DEFINITIONS["muster-roll"], "2026-03-01")).toEqual({
      from: "2026-02-23",
      to: "2026-03-01",
    });
    expect(defaultDates(REPORT_DEFINITIONS["invoice-ageing"], "2026-03-01")).toEqual({
      asAt: "2026-03-01",
    });
    expect(defaultDates(REPORT_DEFINITIONS["budget-vs-actual"], "2026-03-01")).toEqual({});
  });
});
