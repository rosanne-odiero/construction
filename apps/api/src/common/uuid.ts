import { randomBytes } from "node:crypto";

/**
 * A UUID version 7 (RFC 9562): a 48-bit Unix millisecond timestamp followed by random bits, so
 * IDs sort by creation time (ARCHITECTURE D-06). Used where rows are inserted in bulk with IDs
 * chosen before the insert.
 */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
