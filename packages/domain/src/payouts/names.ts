import type { NameCheckResult } from "@pm-buddy/types";

/**
 * Receiver-name check on confirmed B2C results (D4.3 §8; THREAT_MODEL A-22; CR-PMT-06). M-Pesa
 * returns `ReceiverPartyPublicName` as "<MSISDN> - <NAME>" (the number may be masked). The name is
 * compared with the labourer's registered full name after normalising case, accents, punctuation
 * and word order, with token-level fuzzy matching (normalised edit distance) so a missing middle
 * name or a one-letter typo still matches. This is detection evidence after a payout, never
 * pre-payment verification: a mismatch places a hold on future payouts and alerts.
 */

const NAME_MAX = 100;
const PREFIXED = /^\+?[\d*•]{5,15}\s*(?:-\s*)?(.*)$/u;
/** English and Kiswahili honorifics carried by some registered names (dropped before comparing). */
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "eng", "rev", "hon", "bw", "bi"]);

/**
 * "254708374149 - John Doe" → "John Doe"; also tolerates a masked or space-separated number and a
 * bare name. Null when there is no name (absent, empty or only a number): the check is then
 * `unavailable`.
 */
export function parseReceiverPartyPublicName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const separator = text.indexOf(" - ");
  const name =
    separator >= 0 ? text.slice(separator + 3) : (PREFIXED.exec(text)?.[1] ?? text).trim();
  const trimmed = name.trim().slice(0, NAME_MAX).trim();
  return /\p{L}/u.test(trimmed) ? trimmed : null;
}

/**
 * Lower-case words without accents, punctuation, digits or honorifics ("O'Neil, Mr J." → oneil, j).
 */
export function nameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’`ʼ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token !== "" && !TITLES.has(token) && !/^\p{N}+$/u.test(token));
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** 1 − edit distance / longer length (1 = identical). */
function textSimilarity(a: string, b: string): number {
  const length = Math.max(Array.from(a).length, Array.from(b).length);
  return length === 0 ? 1 : 1 - editDistance(a, b) / length;
}

/** Two name words: an initial earns half credit when it starts the other word. */
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (Array.from(a).length === 1 || Array.from(b).length === 1)
    return Array.from(a)[0] === Array.from(b)[0] ? 0.5 : 0;
  return textSimilarity(a, b);
}

/**
 * Similarity of two names in [0, 1], rounded to three decimals. Each word of the shorter name is
 * paired with its best unused word of the longer one (any order) and the pair scores are averaged
 * over the shorter name's words — but over at least two words when the longer name has two or
 * more, so one shared first name alone never matches a full name. Names written as one word
 * ("MARYANN" for "Mary Ann") are also compared joined up; the better score counts.
 */
export function nameSimilarity(a: string, b: string): number {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.length || !right.length) return 0;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  const pairs: { i: number; j: number; score: number }[] = [];
  for (let i = 0; i < short.length; i += 1)
    for (let j = 0; j < long.length; j += 1)
      pairs.push({ i, j, score: tokenSimilarity(short[i]!, long[j]!) });
  pairs.sort((x, y) => y.score - x.score || x.i - y.i || x.j - y.j);
  const usedShort = new Set<number>();
  const usedLong = new Set<number>();
  let total = 0;
  for (const pair of pairs) {
    if (usedShort.has(pair.i) || usedLong.has(pair.j)) continue;
    usedShort.add(pair.i);
    usedLong.add(pair.j);
    total += pair.score;
  }
  const tokenScore = total / Math.max(short.length, Math.min(2, long.length));
  const joinedScore = textSimilarity(left.join(""), right.join(""));
  return Math.round(Math.max(tokenScore, joinedScore) * 1000) / 1000;
}

/**
 * The name check of a confirmed payout: `unavailable` without a receiver name (or a registered
 * name with no letters); otherwise `match` when the similarity reaches the company threshold
 * (`payments.name_match.threshold`, default 0.80), else `mismatch`.
 */
export function checkRecipientName(input: {
  receiverName: string | null;
  registeredName: string;
  threshold: number;
}): { result: NameCheckResult; score: number | null } {
  if (
    !input.receiverName ||
    !nameTokens(input.receiverName).length ||
    !nameTokens(input.registeredName).length
  )
    return { result: "unavailable", score: null };
  const score = nameSimilarity(input.receiverName, input.registeredName);
  return { result: score >= input.threshold ? "match" : "mismatch", score };
}
