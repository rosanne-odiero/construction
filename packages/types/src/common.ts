export const CURRENCIES = ["KES", "USD", "GBP", "EUR"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Money on the wire: integer minor units plus currency (ARCHITECTURE §9). */
export interface Money {
  amountMinor: number;
  currency: Currency;
}

export const LOCALES = ["en", "sw"] as const;
export type Locale = (typeof LOCALES)[number];

export const BUSINESS_TIME_ZONE = "Africa/Nairobi";
