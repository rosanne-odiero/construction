/**
 * Exact, non-negative rational numbers on BigInt (D5.1 unit conversions). Conversion factors are
 * kept as fractions, so chaining factors (trip → t → kg, or d²/162 kg per metre) never rounds; a
 * converted quantity is rounded exactly once, half-up, at the end. No floating point is used.
 */

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

const gcd = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b) [a, b] = [b, a % b];
  return a;
};

const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);

/** Parses a non-negative decimal string ("12", "0.3048") into an integer and a scale. */
export function parseUnsignedDecimal(input: string): { digits: bigint; scale: number } | null {
  const match = DECIMAL.exec(input);
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { digits: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

/** Rounds n / d (n ≥ 0, d > 0) half-up to an integer. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new RangeError("divideHalfUp needs n ≥ 0, d > 0");
  return (2n * numerator + denominator) / (2n * denominator);
}

/** A scaled integer as a decimal string, without trailing zeros unless `trim` is false. */
export function formatScaled(value: bigint, scale: number, trim = true): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = scale ? digits.slice(0, -scale) : digits;
  let fraction = scale ? digits.slice(-scale) : "";
  if (trim) fraction = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export class Ratio {
  /** Always reduced, with a positive denominator. */
  private constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
  ) {}

  static readonly ONE = new Ratio(1n, 1n);

  static of(numerator: bigint | number, denominator: bigint | number = 1n): Ratio {
    const num = BigInt(numerator);
    const den = BigInt(denominator);
    if (den <= 0n) throw new RangeError("A ratio needs a positive denominator");
    if (num < 0n) throw new RangeError("Conversion ratios are never negative");
    const divisor = gcd(num, den) || 1n;
    return new Ratio(num / divisor, den / divisor);
  }

  /** "0.3048" → 381/1250. Throws on anything that is not a plain non-negative decimal. */
  static fromDecimal(input: string): Ratio {
    const parsed = parseUnsignedDecimal(input);
    if (!parsed) throw new TypeError(`Not a non-negative decimal: "${input}"`);
    return Ratio.of(parsed.digits, pow10(parsed.scale));
  }

  /** "1" trip = "7" t → 7/1; "12.5" nr = "1" m² → 2/25 (to-units per from-unit). */
  static fromQuantities(fromQuantity: string, toQuantity: string): Ratio {
    const from = Ratio.fromDecimal(fromQuantity);
    const to = Ratio.fromDecimal(toQuantity);
    if (from.isZero() || to.isZero())
      throw new RangeError("A conversion needs a positive quantity on both sides");
    return to.dividedBy(from);
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  plus(other: Ratio): Ratio {
    return Ratio.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  /** |this − other|, and whether this is below other. */
  distance(other: Ratio): { value: Ratio; below: boolean } {
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    const below = left < right;
    return {
      value: Ratio.of(below ? right - left : left - right, this.denominator * other.denominator),
      below,
    };
  }

  times(other: Ratio): Ratio {
    return Ratio.of(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  dividedBy(other: Ratio): Ratio {
    if (other.isZero()) throw new RangeError("Division by zero");
    return Ratio.of(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  inverse(): Ratio {
    if (this.isZero()) throw new RangeError("Zero has no inverse");
    return Ratio.of(this.denominator, this.numerator);
  }

  equals(other: Ratio): boolean {
    return this.numerator === other.numerator && this.denominator === other.denominator;
  }

  /** −1, 0 or 1. */
  compare(other: Ratio): number {
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    return left === right ? 0 : left < right ? -1 : 1;
  }

  /** Whether the value has a finite decimal expansion (the denominator has only 2s and 5s). */
  terminates(): boolean {
    let den = this.denominator;
    while (den % 2n === 0n) den /= 2n;
    while (den % 5n === 0n) den /= 5n;
    return den === 1n;
  }

  /**
   * The value rounded half-up to `decimals` places, and whether that is exact. Trailing zeros are
   * trimmed unless `fixed` is set.
   */
  toDecimal(decimals: number, fixed = false): { value: string; exact: boolean } {
    const scaled = this.numerator * pow10(decimals);
    return {
      value: formatScaled(divideHalfUp(scaled, this.denominator), decimals, !fixed),
      exact: scaled % this.denominator === 0n,
    };
  }

  /** "num/den" for storage and audit snapshots. */
  toString(): string {
    return `${this.numerator}/${this.denominator}`;
  }

  static parse(text: string): Ratio {
    const match = /^(\d+)\/(\d+)$/.exec(text);
    if (!match) throw new TypeError(`Not a ratio: "${text}"`);
    return Ratio.of(BigInt(match[1]!), BigInt(match[2]!));
  }
}
