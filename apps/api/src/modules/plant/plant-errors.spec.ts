import { ConflictException, ForbiddenException, HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { plantDatabaseProblem } from "./plant-errors.js";

/** A Prisma driver-adapter error as the database reports it. */
const databaseError = (code: string, message: string) =>
  Object.assign(new Error("query failed"), {
    meta: { driverAdapterError: { cause: { code, message } } },
  });

describe("plantDatabaseProblem", () => {
  it("turns trigger refusals into a 409 without echoing the database message", () => {
    const mapped = plantDatabaseProblem(
      databaseError("23514", "The item was not at this site on that day"),
    );
    expect(mapped).toBeInstanceOf(ConflictException);
    expect(mapped?.getResponse()).toMatchObject({ code: "plant-rule" });
    expect(JSON.stringify(mapped?.getResponse())).not.toMatch(/this site on that day/);
    expect(
      plantDatabaseProblem(databaseError("23505", "duplicate key"))?.getResponse(),
    ).toMatchObject({ code: "plant-rule" });
    expect(plantDatabaseProblem(databaseError("23503", "foreign key"))).toBeInstanceOf(
      ConflictException,
    );
  });

  it("keeps the meter code for a refused reading", () => {
    expect(
      plantDatabaseProblem(
        databaseError(
          "23514",
          "A meter reading cannot be lower than an earlier one or higher than a later one; record a meter reset",
        ),
      )?.getResponse(),
    ).toMatchObject({ code: "meter-out-of-order" });
  });

  it("answers 403 for refused privileges and leaves other errors alone", () => {
    expect(
      plantDatabaseProblem(databaseError("42501", "Usage logs are append-only")),
    ).toBeInstanceOf(ForbiddenException);
    expect(plantDatabaseProblem(new HttpException("already a problem", 409))).toBeNull();
    expect(plantDatabaseProblem(databaseError("57014", "statement timeout"))).toBeNull();
    expect(plantDatabaseProblem(new Error("boom"))).toBeNull();
  });
});
