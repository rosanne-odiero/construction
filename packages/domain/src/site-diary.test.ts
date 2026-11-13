import { describe, expect, it } from "vitest";
import { DIARY_ACTIONS, DIARY_STATUSES, diaryTransition } from "./site-diary.js";

describe("site diary lifecycle", () => {
  it("allows only submission, independent review and reopening a rejection", () => {
    const allowed = {
      "draft:submit": "submitted",
      "submitted:approve": "approved",
      "submitted:reject": "rejected",
      "rejected:reopen": "draft",
    };
    for (const status of DIARY_STATUSES)
      for (const action of DIARY_ACTIONS)
        expect(diaryTransition(status, action)).toBe(
          allowed[`${status}:${action}` as keyof typeof allowed] ?? null,
        );
  });
});
