import { ConflictException, ForbiddenException, HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { supplierPortalDatabaseProblem } from "./supplier-portal-access.js";

/** A Prisma driver-adapter error as the database reports it. */
const databaseError = (code: string, message: string) =>
  Object.assign(new Error("query failed"), {
    meta: { driverAdapterError: { cause: { code, message } } },
  });

describe("supplierPortalDatabaseProblem", () => {
  it("turns trigger refusals and key clashes into a 409 without echoing the database", () => {
    const mapped = supplierPortalDatabaseProblem(
      databaseError("23514", "A supplier-submitted invoice is never reopened"),
    );
    expect(mapped).toBeInstanceOf(ConflictException);
    expect(mapped?.getResponse()).toMatchObject({ code: "supplier-portal-rule" });
    expect(JSON.stringify(mapped?.getResponse())).not.toMatch(/never reopened/);
    for (const code of ["23505", "23503"])
      expect(supplierPortalDatabaseProblem(databaseError(code, "key"))).toBeInstanceOf(
        ConflictException,
      );
  });

  it("answers 403 when the database refuses a supplier's write and leaves the rest alone", () => {
    const mapped = supplierPortalDatabaseProblem(
      databaseError("42501", "A supplier never changes invoice_settlements rows"),
    );
    expect(mapped).toBeInstanceOf(ForbiddenException);
    expect(mapped?.getResponse()).toMatchObject({ code: "supplier-portal-forbidden" });
    expect(supplierPortalDatabaseProblem(new HttpException("already a problem", 409))).toBeNull();
    expect(supplierPortalDatabaseProblem(databaseError("57014", "statement timeout"))).toBeNull();
    expect(supplierPortalDatabaseProblem(new Error("boom"))).toBeNull();
  });
});
