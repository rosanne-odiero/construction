import { DEFAULT_PAYOUT_SETTINGS } from "@pm-buddy/types";
import { describe, expect, it } from "vitest";
import {
  checkRecipientName,
  nameSimilarity,
  nameTokens,
  parseReceiverPartyPublicName,
} from "../index.js";

const threshold = DEFAULT_PAYOUT_SETTINGS.nameMatchThreshold;
const check = (receiverName: string | null, registeredName: string) =>
  checkRecipientName({ receiverName, registeredName, threshold }).result;

describe("receiver name from a B2C result (ReceiverPartyPublicName)", () => {
  it("takes the part after the number", () => {
    expect(parseReceiverPartyPublicName("254708374149 - John Doe")).toBe("John Doe");
    expect(parseReceiverPartyPublicName("2547*****149 - MARY  WANJIRU ")).toBe("MARY WANJIRU");
    expect(parseReceiverPartyPublicName("254708374149 - MARY-ANN - KAMAU")).toBe(
      "MARY-ANN - KAMAU",
    );
    expect(parseReceiverPartyPublicName("254708374149 JOHN DOE")).toBe("JOHN DOE");
    expect(parseReceiverPartyPublicName("JOHN DOE")).toBe("JOHN DOE");
  });

  it("has no name when the result carries none", () => {
    expect(parseReceiverPartyPublicName("254708374149 - ")).toBeNull();
    expect(parseReceiverPartyPublicName("254708374149")).toBeNull();
    expect(parseReceiverPartyPublicName("")).toBeNull();
    expect(parseReceiverPartyPublicName(undefined)).toBeNull();
    expect(parseReceiverPartyPublicName(254708374149)).toBeNull();
  });
});

describe("recipient name check (golden cases, threshold 0.80)", () => {
  it.each([
    ["JOHN DOE", "John Kamau Doe"],
    ["DOE JOHN", "John Doe"],
    ["JON DOE", "John Doe"],
    ["O'NEIL, JOHN", "John O'Neil"],
    ["JOSE MUNOZ", "José Muñoz"],
    ["MARYANN WANJIKU", "Mary Ann Wanjiku"],
    ["PETER NG'ANG'A KAMAU", "Peter Ngʼangʼa"],
    ["MR JOHN DOE", "John Doe"],
    ["MARIA WANJIRU", "Mary Wanjiru"],
  ])("%s matches %s", (receiver, registered) => {
    expect(check(receiver, registered)).toBe("match");
  });

  it.each([
    ["MARY WANJIRU", "John Doe"],
    ["JANE DOE", "John Doe"],
    ["JOHN", "John Kamau Doe"],
    ["J DOE", "John Doe"],
    ["PETER OTIENO", "Paul Odhiambo"],
  ])("%s does not match %s", (receiver, registered) => {
    expect(check(receiver, registered)).toBe("mismatch");
  });

  it("is unavailable without a receiver name", () => {
    expect(
      checkRecipientName({ receiverName: null, registeredName: "John Doe", threshold }),
    ).toEqual({
      result: "unavailable",
      score: null,
    });
    expect(check("", "John Doe")).toBe("unavailable");
    expect(check("--", "John Doe")).toBe("unavailable");
  });

  it("scores symmetrically in [0, 1] and compares with the configured threshold", () => {
    expect(nameSimilarity("John Doe", "JOHN DOE")).toBe(1);
    expect(nameSimilarity("MARY WANJIRU", "Mary Wanjiru Njeri")).toBe(1);
    expect(nameSimilarity("Jane Doe", "John Doe")).toBe(nameSimilarity("John Doe", "Jane Doe"));
    expect(nameSimilarity("MARIA WANJIRU", "Mary Wanjiru")).toBe(0.833);
    expect(
      checkRecipientName({
        receiverName: "MARIA WANJIRU",
        registeredName: "Mary Wanjiru",
        threshold: 0.84,
      }),
    ).toEqual({ result: "mismatch", score: 0.833 });
    expect(nameTokens("Dr. O’Brien-Kamau, 2nd")).toEqual(["obrien", "kamau", "2nd"]);
  });
});
