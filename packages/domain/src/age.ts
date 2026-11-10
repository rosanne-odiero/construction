const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(isoDate: string): [number, number, number] {
  const match = ISO_DATE.exec(isoDate);
  if (!match) throw new TypeError(`Expected a YYYY-MM-DD date, got "${isoDate}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Age in whole years on a given calendar date. Works on calendar dates (no time zones), so a
 * birthday counts from the start of that day in Africa/Nairobi as everywhere else.
 */
export function ageOn(dateOfBirth: string, onDate: string): number {
  const [by, bm, bd] = parts(dateOfBirth);
  const [y, m, d] = parts(onDate);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

// COMPLIANCE-REVIEW: the minimum age comes from config (`labour.minimum_age_years`, seed 18; CR-DP-10).
export function meetsMinimumAge(dateOfBirth: string, onDate: string, minimumYears = 18): boolean {
  return ageOn(dateOfBirth, onDate) >= minimumYears;
}
