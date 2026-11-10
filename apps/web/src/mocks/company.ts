/** Prototype "now": all mock data is relative to Tuesday 10/11/2026 07:45 EAT. */
export const NOW = "2026-11-10T07:45:00+03:00";

export const company = {
  name: "Jenga Bora Builders Ltd",
  shortName: "Jenga Bora",
};

export const currentUser = {
  name: "Wanjiru Kamau",
  email: "wanjiru@jengabora.example",
  roleKey: "director" as const,
  approvalLimitMinor: 2_000_000_00,
};

export const people = {
  pm: "Brian Otieno",
  qs: "Faith Achieng",
  finance: "Daniel Mwangi",
  siteAgent: "Kevin Kiprono",
  foreman: "Joseph Mutua",
  storekeeper: "Mary Njeri",
  architect: "Arch. Linet Muriuki",
  engineer: "Eng. Samuel Otieno",
};

/** Small deterministic PRNG so mock data is stable between renders and builds. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
