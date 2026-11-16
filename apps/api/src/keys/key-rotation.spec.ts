import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli-args.js";
import { FIELD_COLUMNS } from "./key-rotation.js";

describe("key rotation catalogue", () => {
  it("covers every encrypted (Bytes *_enc) column in the schema, so none is left on an old key", () => {
    const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    const found: string[] = [];
    for (const block of schema.split(/\nmodel /).slice(1)) {
      const table = /@@map\("([a-z_]+)"\)/.exec(block)?.[1];
      for (const line of block.split("\n")) {
        const column = /^\s+\w+\s+Bytes\??\s.*@map\("([a-z_]+_enc)"\)/.exec(line)?.[1];
        if (table && column) found.push(`${table}.${column}`);
      }
    }
    expect(found.length).toBeGreaterThanOrEqual(10);
    // Biometric templates are sealed to a separate key pair and re-sealed by rewrapBiometric.
    expect(
      [
        ...FIELD_COLUMNS.map(({ table, column }) => `${table}.${column}`),
        "biometric_templates.template_enc",
      ].sort(),
    ).toEqual(found.sort());
  });
});

describe("keys:rotate arguments", () => {
  it("records who ran a rewrap and accepts only known options", () => {
    expect(() => parseArgs(["rewrap"])).toThrow(/--operator/);
    expect(parseArgs(["rewrap", "--operator", "Jane Ops", "--only", "field", "--dry-run"])).toEqual(
      { command: "rewrap", operator: "Jane Ops", only: "field", dryRun: true },
    );
    expect(parseArgs(["rewrap", "--operator", "Jane Ops", "--only", "biometric"]).only).toBe(
      "biometric",
    );
    expect(() => parseArgs(["rewrap", "--operator", "Jane", "--only", "blind-index"])).toThrow();
    expect(() => parseArgs(["status", "--tenant", "not-a-uuid"])).toThrow();
    expect(() => parseArgs(["status", "--force"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["drop"])).toThrow();
  });
});
