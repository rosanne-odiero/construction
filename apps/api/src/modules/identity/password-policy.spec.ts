import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../config/app-config.js";
import {
  breachCheckerFor,
  HibpBreachChecker,
  NoBreachCheck,
  PasswordBreachChecker,
  PasswordPolicy,
  PasswordRejectedException,
  userInputs,
} from "./password-policy.js";

const strong = "Unique construction foundation! 918";
const sha1 = (value: string) => createHash("sha1").update(value).digest("hex").toUpperCase();

class FakeBreaches extends PasswordBreachChecker {
  constructor(private readonly breached: ReadonlySet<string>) {
    super();
  }
  isBreached(password: string) {
    return Promise.resolve(this.breached.has(password));
  }
}

describe("Password policy", () => {
  afterEach(() => vi.restoreAllMocks());
  const policy = new PasswordPolicy(new NoBreachCheck());
  const context = { identifier: "wanjiru.kamau@example.test", displayName: "Wanjiru Kamau" };

  it("accepts strong passphrases without composition rules", async () => {
    await expect(policy.assertAcceptable(strong, context)).resolves.toBeUndefined();
    await expect(
      policy.assertAcceptable("an uncommon long phrase for construction", context),
    ).resolves.toBeUndefined();
  });

  it.each([
    "password1234",
    "qwertyuiop123",
    "aaaaaaaaaaaaaaaa",
    "Kenya2026Kenya2026",
    "wanjiru.kamau@example.test",
    "Wanjiru Kamau 1",
    "wanjiru.kamau1",
    "PMBuddy123456",
  ])("refuses %j as too weak with a generic code", async (password) => {
    const error = await policy
      .assertAcceptable(password, context)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PasswordRejectedException);
    expect((error as PasswordRejectedException).getResponse()).toEqual({
      code: "password-too-weak",
      message: expect.stringContaining("too easy to guess") as string,
    });
    expect(JSON.stringify((error as PasswordRejectedException).getResponse())).not.toMatch(
      /score|\d\/4/i,
    );
  });

  it("uses the account's identifier and name as context", () => {
    // Strong for a stranger, weak for the account it names.
    expect(policy.score("Wanjiru Kamau 1", { identifier: "x@example.test" })).toBe(4);
    expect(policy.score("Wanjiru Kamau 1", context)).toBeLessThan(3);
    expect(userInputs("254712345678", "Otieno Builder")).toEqual(
      expect.arrayContaining(["254712345678", "0712345678", "otieno", "builder", "pmbuddy"]),
    );
  });

  it("refuses breached passwords after the strength check passes", async () => {
    const breached = new PasswordPolicy(new FakeBreaches(new Set([strong])));
    await expect(breached.assertAcceptable(strong, context)).rejects.toMatchObject({
      response: { code: "password-breached" },
      status: 400,
    });
    await expect(
      breached.assertAcceptable("an uncommon long phrase for construction", context),
    ).resolves.toBeUndefined();
  });

  it("selects the breach checker from configuration (off by default)", () => {
    const config = (mode: string) => ({ get: () => mode }) as unknown as AppConfig;
    expect(breachCheckerFor(config("off"))).toBeInstanceOf(NoBreachCheck);
    expect(breachCheckerFor(config("hibp"))).toBeInstanceOf(HibpBreachChecker);
  });
});

describe("Have I Been Pwned range check (no network: fetch is faked)", () => {
  afterEach(() => vi.restoreAllMocks());
  const hash = sha1(strong);

  it("sends only the five-character prefix with padding and matches the suffix", async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(
          [`${"0".repeat(35)}:3`, `${hash.slice(5)}:12`, `${"F".repeat(35)}:0`].join("\r\n"),
        ),
      ),
    );
    expect(await new HibpBreachChecker(fetcher).isBreached(strong)).toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    expect(url).not.toContain(hash.slice(5));
    expect(init.headers).toMatchObject({ "Add-Padding": "true" });
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("error");
  });

  it("ignores padding entries and absent suffixes", async () => {
    const padded = new Response(`${hash.slice(5)}:0\r\n${"A".repeat(35)}:4`);
    expect(await new HibpBreachChecker(() => Promise.resolve(padded)).isBreached(strong)).toBe(
      false,
    );
  });

  it.each([
    ["an error status", () => Promise.resolve(new Response("busy", { status: 503 }))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "a timeout",
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
    ],
  ])("fails open on %s and logs a warning without the password or hash", async (_case, fetcher) => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    expect(await new HibpBreachChecker(fetcher, 20).isBreached(strong)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("Breached-password check skipped");
    for (const secret of [strong, hash, hash.slice(0, 5), hash.slice(5)])
      expect(logged).not.toContain(secret);
  });
});
