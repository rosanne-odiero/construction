import { ConflictException, ForbiddenException, HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { documentsDatabaseProblem } from "./documents-errors.js";

/** A Prisma driver-adapter error as the database reports it. */
const databaseError = (code: string, message: string) =>
  Object.assign(new Error("query failed"), {
    meta: { driverAdapterError: { cause: { code, message } } },
  });

describe("documentsDatabaseProblem", () => {
  it("turns trigger, index and commit-time refusals into a 409 without the database message", () => {
    const mapped = documentsDatabaseProblem(
      databaseError("23514", "A document has exactly one current version: the newest"),
    );
    expect(mapped).toBeInstanceOf(ConflictException);
    expect(mapped?.getResponse()).toMatchObject({ code: "documents-rule" });
    expect(JSON.stringify(mapped?.getResponse())).not.toMatch(/current version/);
    for (const code of ["23505", "23503", "23P01"])
      expect(documentsDatabaseProblem(databaseError(code, "x"))).toBeInstanceOf(ConflictException);
  });

  it("answers 403 for refused privileges and leaves other errors alone", () => {
    expect(
      documentsDatabaseProblem(databaseError("42501", "Document versions are never deleted")),
    ).toBeInstanceOf(ForbiddenException);
    expect(documentsDatabaseProblem(new HttpException("already a problem", 409))).toBeNull();
    expect(documentsDatabaseProblem(databaseError("57014", "statement timeout"))).toBeNull();
    expect(documentsDatabaseProblem(new Error("boom"))).toBeNull();
  });
});
