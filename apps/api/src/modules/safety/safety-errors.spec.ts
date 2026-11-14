import { ConflictException, ForbiddenException, HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { safetyDatabaseProblem } from "./safety-errors.js";

/** A Prisma driver-adapter error as the database reports it. */
const databaseError = (code: string, message: string) =>
  Object.assign(new Error("query failed"), {
    meta: { driverAdapterError: { cause: { code, message } } },
  });

describe("safetyDatabaseProblem", () => {
  it("turns trigger refusals into a 409 without echoing the database message", () => {
    const mapped = safetyDatabaseProblem(
      databaseError("23514", "The investigation's author changes only with the investigation"),
    );
    expect(mapped).toBeInstanceOf(ConflictException);
    expect(mapped?.getResponse()).toMatchObject({ code: "safety-rule" });
    expect(JSON.stringify(mapped?.getResponse())).not.toMatch(/investigation's author/);
    expect(safetyDatabaseProblem(databaseError("23505", "duplicate key"))).toBeInstanceOf(
      ConflictException,
    );
    expect(safetyDatabaseProblem(databaseError("23503", "foreign key"))).toBeInstanceOf(
      ConflictException,
    );
  });

  it("answers 403 for refused privileges and leaves other errors alone", () => {
    expect(
      safetyDatabaseProblem(databaseError("42501", "Incident photos cannot be removed")),
    ).toBeInstanceOf(ForbiddenException);
    expect(safetyDatabaseProblem(new HttpException("already a problem", 409))).toBeNull();
    expect(safetyDatabaseProblem(databaseError("57014", "statement timeout"))).toBeNull();
    expect(safetyDatabaseProblem(new Error("boom"))).toBeNull();
  });
});
