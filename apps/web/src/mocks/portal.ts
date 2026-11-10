/** Client portal data for the diaspora client's Kitengela bungalow. Demo data only. */

export const portalClient = {
  name: "Dr. Grace Wambui",
  location: "London, UK",
  preferredCurrency: "GBP" as const,
};

// Indicative display-only rates; real rates come from the FX provider (ConfigRule / FxRate).
export const fxRates = {
  asOf: "2026-11-10T09:00:00+03:00",
  USD: 129.2,
  GBP: 172.4,
  EUR: 149.8,
};

// COMPLIANCE-REVIEW: M-Pesa per-transaction limit is configurable (mpesa.stk.max_per_transaction).
export const MPESA_STK_LIMIT_MINOR = 250_000_00;

export const portalPhotos = [
  {
    id: "ph-1",
    caption: "internalPlaster",
    date: "2026-11-07T15:42:00+03:00",
    verified: true,
    location: "Living room",
    tone: "from-amber-200 to-stone-400",
  },
  {
    id: "ph-2",
    caption: "windowFrames",
    date: "2026-10-28T11:05:00+03:00",
    verified: true,
    location: "Bedrooms 2 and 3",
    tone: "from-sky-200 to-slate-400",
  },
  {
    id: "ph-3",
    caption: "roofSheets",
    date: "2026-10-03T16:20:00+03:00",
    verified: true,
    location: "Roof",
    tone: "from-blue-300 to-indigo-500",
  },
  {
    id: "ph-4",
    caption: "roofTrusses",
    date: "2026-09-29T10:48:00+03:00",
    verified: true,
    location: "Roof",
    tone: "from-orange-200 to-amber-500",
  },
  {
    id: "ph-5",
    caption: "septicTank",
    date: "2026-09-02T09:12:00+03:00",
    verified: false,
    location: "Back yard",
    tone: "from-stone-300 to-stone-500",
  },
  {
    id: "ph-6",
    caption: "ringBeam",
    date: "2026-08-22T12:30:00+03:00",
    verified: true,
    location: "Whole house",
    tone: "from-zinc-200 to-zinc-500",
  },
] as const;

export const certificates = [
  {
    number: "IPC-01",
    issued: "2026-06-20",
    amountMinor: 2_480_000_00,
    paidMinor: 2_480_000_00,
    status: "paid",
  },
  {
    number: "IPC-02",
    issued: "2026-08-28",
    amountMinor: 1_964_500_00,
    paidMinor: 1_964_500_00,
    status: "paid",
  },
  {
    number: "IPC-03",
    issued: "2026-11-06",
    amountMinor: 1_245_600_00,
    paidMinor: 0,
    status: "due",
    due: "2026-11-20",
  },
] as const;

export const pendingVariation = {
  number: "VO-002",
  instruction: "AI-003",
  architect: "Arch. Linet Muriuki",
  amountMinor: 186_000_00,
  issued: "2026-11-05",
};

export const paymentInstructions = {
  paybill: "000000",
  account: "KIT-BNG-IPC03",
};

export const diaryWeek = { avgWorkers: 9, plasterPct: 72, rainDays: 1 };
