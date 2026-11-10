import { describe, expect, it } from "vitest";
import { catalogues, DEFAULT_LOCALE, isLocale, LOCALES, messages } from "./index.js";

const keys = (tree: object, prefix = ""): string[] =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? keys(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );

describe("message catalogues", () => {
  it("ships English and Kiswahili", () => {
    expect(LOCALES).toEqual(["en", "sw"]);
    expect(Object.keys(catalogues).sort()).toEqual(["en", "sw"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("returns each locale's catalogue and falls back to English", () => {
    expect(messages("sw")).toBe(catalogues.sw);
    expect(messages("en")).toBe(catalogues.en);
    expect(messages("fr")).toBe(catalogues.en);
    expect(messages(undefined)).toBe(catalogues.en);
    expect(isLocale("sw")).toBe(true);
    expect(isLocale("SW")).toBe(false);
  });

  it("has the same keys in both languages and translates the foundation console", () => {
    expect(keys(catalogues.sw)).toEqual(keys(catalogues.en));
    expect(catalogues.en.foundation.title).not.toBe(catalogues.sw.foundation.title);
  });
});
