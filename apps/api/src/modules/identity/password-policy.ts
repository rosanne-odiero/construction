import { createHash } from "node:crypto";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import * as english from "@zxcvbn-ts/language-en";
import type { PasswordProblemCode } from "@pm-buddy/validation";
import type { AppConfig } from "../../config/app-config.js";

/** zxcvbn score (0–4) a new password must reach: 3 = "safely unguessable" against online attacks. */
export const MINIMUM_PASSWORD_SCORE = 3;
/** Only this prefix is scored: zxcvbn's cost grows with length, and longer passwords pass anyway. */
const SCORED_LENGTH = 64;
const PRODUCT_WORDS = ["pm-buddy", "pmbuddy", "pm buddy"];

/** 400 with a generic code; the score, matched words and any breach count stay on the server. */
export class PasswordRejectedException extends BadRequestException {
  constructor(code: PasswordProblemCode) {
    super({
      code,
      message:
        code === "password-breached"
          ? "This password appears in a known data breach. Choose a different password."
          : "This password is too easy to guess. Choose a longer or less predictable password.",
    });
  }
}

/** Decides whether a password appears in known breaches. Implementations must fail open. */
export abstract class PasswordBreachChecker {
  abstract isBreached(password: string): Promise<boolean>;
}

/** AUTH_BREACHED_PASSWORD_CHECK=off (the default). */
export class NoBreachCheck extends PasswordBreachChecker {
  isBreached(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Have I Been Pwned range API with k-anonymity: only the first five hex characters of the
 * password's SHA-1 are sent, and `Add-Padding` hides the real size of the answer. A slow or failed
 * lookup is logged (without the password or any part of its hash) and treated as "not breached",
 * so an outage never blocks registration or recovery.
 */
export class HibpBreachChecker extends PasswordBreachChecker {
  private readonly logger = new Logger(HibpBreachChecker.name);

  constructor(
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
      fetch(url, init),
    private readonly timeoutMs = 2000,
  ) {
    super();
  }

  async isBreached(password: string): Promise<boolean> {
    const hash = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
    const suffix = hash.slice(5);
    try {
      const response = await this.fetcher(
        `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`,
        {
          headers: { "Add-Padding": "true", "User-Agent": "PM-Buddy password check" },
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!response.ok) throw new BreachLookupError(`status ${response.status}`);
      for (const line of (await response.text()).split("\n")) {
        const [candidate, count] = line.trim().split(":");
        // Padding entries carry a count of 0.
        if (candidate === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch (error) {
      const reason =
        error instanceof BreachLookupError
          ? error.message
          : error instanceof DOMException && error.name === "TimeoutError"
            ? "timeout"
            : "network error";
      this.logger.warn(`Breached-password check skipped (${reason}); the password was accepted`);
      return false;
    }
  }
}

class BreachLookupError extends Error {}

export function breachCheckerFor(config: AppConfig): PasswordBreachChecker {
  return config.get("AUTH_BREACHED_PASSWORD_CHECK") === "hibp"
    ? new HibpBreachChecker()
    : new NoBreachCheck();
}

/** Words an attacker who knows the account would try first. */
export function userInputs(identifier: string, displayName = ""): string[] {
  const inputs = [identifier, ...PRODUCT_WORDS];
  if (identifier.includes("@")) {
    const [local = "", domain = ""] = identifier.split("@");
    inputs.push(local, domain, ...local.split(/[^\p{L}\p{N}]+/u));
  } else if (/^254\d{9}$/.test(identifier)) {
    inputs.push(`0${identifier.slice(3)}`, identifier.slice(3));
  }
  if (displayName) inputs.push(displayName, ...displayName.split(/\s+/));
  return [...new Set(inputs.map((value) => value.trim().toLowerCase()))].filter(
    (value) => value.length >= 3,
  );
}

/**
 * Server-side password policy for every new password (registration and reset; ARCHITECTURE §7).
 * Length bounds stay in the request schemas; this adds zxcvbn strength in context and the
 * optional breach lookup.
 */
@Injectable()
export class PasswordPolicy {
  private readonly zxcvbn = new ZxcvbnFactory({
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...english.dictionary },
    maxLength: SCORED_LENGTH,
  });

  constructor(private readonly breaches: PasswordBreachChecker) {}

  score(password: string, context: { identifier: string; displayName?: string }): number {
    return this.zxcvbn.check(password, userInputs(context.identifier, context.displayName)).score;
  }

  async assertAcceptable(
    password: string,
    context: { identifier: string; displayName?: string },
  ): Promise<void> {
    if (this.score(password, context) < MINIMUM_PASSWORD_SCORE) {
      throw new PasswordRejectedException("password-too-weak");
    }
    if (await this.breaches.isBreached(password)) {
      throw new PasswordRejectedException("password-breached");
    }
  }
}
