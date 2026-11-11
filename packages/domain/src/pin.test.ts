import { describe, expect, it } from "vitest";
import { pinProblem } from "./pin.js";

describe("pinProblem", () => {
  it("accepts six unpatterned digits", () => {
    for (const pin of ["274915", "802461", "530718"]) expect(pinProblem(pin), pin).toBeNull();
    expect(pinProblem("274915", "254712345678")).toBeNull();
  });

  it("refuses wrong formats", () => {
    for (const pin of ["", "12345", "1234567", "12a456", " 274915", "２７４９１５"])
      expect(pinProblem(pin), pin).toBe("format");
  });

  it("refuses repeated digits, pairs and triples", () => {
    for (const pin of ["000000", "999999", "121212", "909090", "123123", "472472"])
      expect(pinProblem(pin), pin).toBe("repeated");
  });

  it("refuses runs up or down, including wrapping past 9", () => {
    for (const pin of ["123456", "234567", "654321", "987654", "890123", "210987"])
      expect(pinProblem(pin), pin).toBe("sequence");
  });

  it("refuses the end of the labourer's phone number", () => {
    expect(pinProblem("093847", "254712093847")).toBe("phone");
    expect(pinProblem("093847", "+254 712 093 847")).toBe("phone");
    expect(pinProblem("093847", null)).toBeNull();
    expect(pinProblem("845021", "254712845021")).toBe("phone");
  });
});
