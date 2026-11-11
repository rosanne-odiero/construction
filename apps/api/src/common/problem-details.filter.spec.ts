import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toProblem } from "./problem-details.filter.js";

describe("toProblem", () => {
  it("maps HTTP exceptions to RFC 9457 problems with stable codes", () => {
    const problem = toProblem(
      new NotFoundException("Project not found"),
      "/api/v1/projects/x",
      "req-123",
    );
    expect(problem).toMatchObject({
      type: "https://pm-buddy.dev/problems/not-found",
      title: "Not Found",
      status: 404,
      code: "not-found",
      detail: "Project not found",
      instance: "/api/v1/projects/x",
      traceId: "req-123",
    });
  });

  it("joins validation messages from Nest's default error shape", () => {
    const problem = toProblem(
      new BadRequestException(["name is required", "phone is invalid"]),
      "/x",
    );
    expect(problem.detail).toBe("name is required; phone is invalid");
    expect(problem.code).toBe("bad-request");
  });

  it("lists Zod issues with their paths", () => {
    const result = z.object({ phone: z.string().min(10) }).safeParse({ phone: "07" });
    const problem = toProblem(result.error, "/x");
    expect(problem.status).toBe(400);
    expect(problem.code).toBe("validation-error");
    expect(problem.errors?.[0]?.path).toBe("phone");
  });

  it("never exposes internal error messages", () => {
    const problem = toProblem(
      new Error("password authentication failed for user pmb_app"),
      "/x",
      "req-9",
    );
    expect(problem.status).toBe(500);
    expect(problem.code).toBe("internal-error");
    expect(JSON.stringify(problem)).not.toContain("pmb_app");
  });

  it("hides details of 5xx HTTP exceptions", () => {
    const problem = toProblem(new HttpException("upstream secret detail", 503), "/x");
    expect(problem.status).toBe(503);
    expect(problem.detail).toBeUndefined();
  });

  it("uses a specific code set by the thrower, ignoring malformed ones", () => {
    const problem = toProblem(
      new BadRequestException({ code: "password-too-weak", message: "Too easy to guess." }),
      "/x",
    );
    expect(problem).toMatchObject({
      type: "https://pm-buddy.dev/problems/password-too-weak",
      status: 400,
      code: "password-too-weak",
      detail: "Too easy to guess.",
    });
    for (const code of ["Not A Code", "<script>", 42, "x"]) {
      expect(toProblem(new BadRequestException({ code, message: "m" }), "/x").code).toBe(
        "bad-request",
      );
    }
  });

  it("names the record a conflict matched, keeping only short safe identifiers", () => {
    const match = { labourerId: "50000000-0000-4000-8000-000000000001", workerNo: "WRK-0001" };
    expect(
      toProblem(new ConflictException({ code: "duplicate-identity", message: "m", match }), "/x")
        .match,
    ).toEqual(match);
    for (const unsafe of [
      { idNumber: "23456789" },
      { workerNo: "WRK 0001" },
      { labourerId: { nested: true } },
      "WRK-0001",
      {},
    ])
      expect(
        toProblem(new ConflictException({ code: "c-x", message: "m", match: unsafe }), "/x").match,
      ).toBeUndefined();
    expect(
      toProblem(new BadRequestException({ code: "c-x", message: "m", match }), "/x").match,
    ).toBeUndefined();
  });
});
