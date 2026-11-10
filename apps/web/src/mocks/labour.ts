import { seededRandom } from "./company";

export type TradeKey =
  | "foreman"
  | "mason"
  | "steel_fixer"
  | "carpenter"
  | "plumber"
  | "electrician"
  | "welder"
  | "plasterer"
  | "machine_operator"
  | "watchman"
  | "general_labourer";

export type SkillLevel = "skilled" | "semi_skilled" | "unskilled";
export type Engagement = "casual" | "term";
export type GangKey = "A" | "B" | "C" | "D" | "E";

export interface Labourer {
  id: string;
  workerNo: string;
  name: string;
  idNumber: string;
  phone: string;
  dob: string;
  homeCounty: string;
  trade: TradeKey;
  skill: SkillLevel;
  engagement: Engagement;
  dailyRateMinor: number;
  gang: GangKey;
  biometricConsent: "granted" | "declined";
  accreditationExpiry?: string;
  continuousDays: number;
  joined: string;
}

export const gangs: Record<GangKey, { name: string; lead: string }> = {
  A: { name: "Gang A: concrete and formwork", lead: "Peter Njoroge Kamau" },
  B: { name: "Gang B: masonry and plaster", lead: "Patrick Wekesa Simiyu" },
  C: { name: "Gang C: steel fixing", lead: "Charles Odhiambo Okoth" },
  D: { name: "Gang D: services", lead: "Kevin Waweru Ndungu" },
  E: { name: "Gang E: security", lead: "Hassan Abdi Noor" },
};

type Row = [
  name: string,
  trade: TradeKey,
  skill: SkillLevel,
  rate: number,
  gang: GangKey,
  county: string,
  extra?: Partial<
    Pick<Labourer, "biometricConsent" | "accreditationExpiry" | "continuousDays" | "engagement">
  >,
];

const rows: Row[] = [
  [
    "Peter Njoroge Kamau",
    "foreman",
    "skilled",
    2_000,
    "A",
    "Kiambu",
    { engagement: "term", accreditationExpiry: "2027-08-31" },
  ],
  [
    "Patrick Wekesa Simiyu",
    "foreman",
    "skilled",
    2_000,
    "B",
    "Bungoma",
    { engagement: "term", accreditationExpiry: "2027-03-15" },
  ],
  [
    "Samuel Kariuki Mwangi",
    "mason",
    "skilled",
    1_500,
    "B",
    "Murang'a",
    { continuousDays: 27, accreditationExpiry: "2027-06-30" },
  ],
  [
    "John Otieno Ouma",
    "mason",
    "skilled",
    1_500,
    "B",
    "Siaya",
    { accreditationExpiry: "2026-11-28" },
  ],
  [
    "Wycliffe Wekesa Barasa",
    "mason",
    "skilled",
    1_500,
    "B",
    "Kakamega",
    { accreditationExpiry: "2027-09-12" },
  ],
  [
    "Stephen Kiprono Rotich",
    "mason",
    "skilled",
    1_500,
    "B",
    "Uasin Gishu",
    { accreditationExpiry: "2027-01-20" },
  ],
  ["Moses Muli Kioko", "mason", "semi_skilled", 1_300, "B", "Machakos"],
  [
    "George Nyakundi Ongeri",
    "mason",
    "skilled",
    1_500,
    "B",
    "Kisii",
    { biometricConsent: "declined", accreditationExpiry: "2027-05-04" },
  ],
  ["Francis Mwenda Kinoti", "mason", "semi_skilled", 1_300, "B", "Meru"],
  [
    "Isaac Kazungu Baya",
    "mason",
    "skilled",
    1_500,
    "B",
    "Kilifi",
    { accreditationExpiry: "2027-07-18" },
  ],
  [
    "Charles Odhiambo Okoth",
    "steel_fixer",
    "skilled",
    1_400,
    "C",
    "Homa Bay",
    { accreditationExpiry: "2026-12-04" },
  ],
  [
    "Erick Owino Onyango",
    "steel_fixer",
    "skilled",
    1_400,
    "C",
    "Kisumu",
    { accreditationExpiry: "2027-02-11" },
  ],
  ["Daniel Cheruiyot Langat", "steel_fixer", "semi_skilled", 1_200, "C", "Kericho"],
  [
    "Michael Musyoka Mutiso",
    "steel_fixer",
    "skilled",
    1_400,
    "C",
    "Makueni",
    { accreditationExpiry: "2027-10-01" },
  ],
  ["Elijah Kipchumba Kibet", "steel_fixer", "semi_skilled", 1_200, "C", "Nandi"],
  [
    "James Kamau Gitau",
    "carpenter",
    "skilled",
    1_400,
    "A",
    "Nyeri",
    { accreditationExpiry: "2027-04-22" },
  ],
  [
    "Paul Ochieng Odhiambo",
    "carpenter",
    "skilled",
    1_400,
    "A",
    "Migori",
    { accreditationExpiry: "2027-06-09" },
  ],
  ["David Kirimi Mwenda", "carpenter", "semi_skilled", 1_200, "A", "Tharaka-Nithi"],
  [
    "Geoffrey Simiyu Wafula",
    "carpenter",
    "skilled",
    1_400,
    "A",
    "Trans Nzoia",
    { accreditationExpiry: "2027-08-14" },
  ],
  ["Joseph Ndolo Mutua", "carpenter", "semi_skilled", 1_200, "A", "Kitui"],
  [
    "Kevin Waweru Ndungu",
    "plumber",
    "skilled",
    1_600,
    "D",
    "Nyandarua",
    { accreditationExpiry: "2027-03-30" },
  ],
  ["Collins Masinde Shikuku", "plumber", "semi_skilled", 1_400, "D", "Vihiga"],
  [
    "Brian Kinoti Murithi",
    "electrician",
    "skilled",
    1_700,
    "D",
    "Meru",
    { accreditationExpiry: "2027-05-27" },
  ],
  [
    "Dennis Ochieng Owiti",
    "electrician",
    "skilled",
    1_700,
    "D",
    "Kisumu",
    { accreditationExpiry: "2027-09-03" },
  ],
  [
    "Abdi Hassan Mohamed",
    "welder",
    "skilled",
    1_600,
    "C",
    "Garissa",
    { accreditationExpiry: "2027-01-08" },
  ],
  [
    "Sankale Lemayian",
    "plasterer",
    "skilled",
    1_400,
    "B",
    "Kajiado",
    { accreditationExpiry: "2027-06-16" },
  ],
  ["Mercy Akinyi Onyango", "plasterer", "semi_skilled", 1_300, "B", "Siaya"],
  ["Simon Kahindi Baya", "machine_operator", "semi_skilled", 1_300, "A", "Kwale"],
  [
    "Hassan Abdi Noor",
    "watchman",
    "unskilled",
    800,
    "E",
    "Wajir",
    { biometricConsent: "declined" },
  ],
  ["Lekishon Mpaka", "watchman", "unskilled", 800, "E", "Narok"],
  [
    "Esther Wanjiku Njeri",
    "general_labourer",
    "unskilled",
    800,
    "B",
    "Kiambu",
    { biometricConsent: "declined" },
  ],
  ["Lucy Moraa Kerubo", "general_labourer", "unskilled", 800, "B", "Nyamira"],
  ["Beatrice Nafula Wekesa", "general_labourer", "unskilled", 800, "A", "Busia"],
  ["Kelvin Mutiso Muli", "general_labourer", "unskilled", 800, "A", "Machakos"],
  ["Dancan Kibet Rono", "general_labourer", "unskilled", 800, "A", "Bomet"],
  ["Felix Okoth Owuor", "general_labourer", "unskilled", 800, "C", "Kisumu"],
  ["Naomi Gatwiri Kirimi", "general_labourer", "unskilled", 800, "D", "Meru"],
  ["Victor Kazungu Charo", "general_labourer", "unskilled", 800, "A", "Kilifi"],
  ["Peter Ndungu Waweru", "general_labourer", "unskilled", 800, "B", "Kiambu"],
  ["Rose Naserian Lemayian", "general_labourer", "unskilled", 800, "B", "Kajiado"],
];

const rand = seededRandom(20261110);
const pad = (n: number, width: number) => String(n).padStart(width, "0");

export const labourers: Labourer[] = rows.map(
  ([name, trade, skill, rate, gang, county, extra], index) => {
    const idNumber = String(20_000_000 + Math.floor(rand() * 19_999_999));
    const prefix = rand() < 0.8 ? "7" : "1";
    const phone = `254${prefix}${pad(Math.floor(rand() * 99_999_999), 8)}`;
    const age = 19 + Math.floor(rand() * 34);
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);
    const joinedMonth = 3 + Math.floor(rand() * 7);
    return {
      id: `lab-${pad(index + 1, 3)}`,
      workerNo: `JBB-${pad(index + 1, 4)}`,
      name,
      idNumber,
      phone,
      dob: `${2026 - age}-${pad(month, 2)}-${pad(day, 2)}`,
      homeCounty: county,
      trade,
      skill,
      engagement: extra?.engagement ?? "casual",
      dailyRateMinor: rate * 100,
      gang,
      biometricConsent: extra?.biometricConsent ?? "granted",
      accreditationExpiry: extra?.accreditationExpiry,
      continuousDays: extra?.continuousDays ?? 5 + Math.floor(rand() * 18),
      joined: `2026-${pad(joinedMonth, 2)}-${pad(1 + Math.floor(rand() * 27), 2)}`,
    };
  },
);

export const labourerById = (id: string) => labourers.find((l) => l.id === id);
export const labourerByName = (name: string) => labourers.find((l) => l.name === name);

// COMPLIANCE-REVIEW: threshold is configurable (brief §5.4); value here is demo-only.
export const CASUAL_CONVERSION_WARNING_DAYS = 25;

export const isAccreditationExpiringSoon = (l: Labourer, nowIso: string, days = 30) => {
  if (!l.accreditationExpiry) return false;
  const diff =
    (new Date(l.accreditationExpiry).getTime() - new Date(nowIso).getTime()) / 86_400_000;
  return diff >= 0 && diff <= days;
};
