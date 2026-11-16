import * as Crypto from "expo-crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "@pm-buddy/domain";
import { pushAttendanceEventSchema, type SignedAttendanceEvent } from "@pm-buddy/validation";
import { deleteSecret, readSecret, saveSecret } from "./secrets";

export type Device = { id: string; publicKey: string; privateKey: string };
export async function deviceFor(userId: string, tenantId: string): Promise<Device> {
  const key = `site.device.${userId}.${tenantId}`;
  const saved = await readSecret(key);
  if (saved) {
    const device = JSON.parse(saved) as Device;
    if (bytesToHex(ed25519.getPublicKey(hexToBytes(device.privateKey))) !== device.publicKey) {
      throw new Error("Device signing key is damaged. Preserve the outbox and contact support.");
    }
    return device;
  }
  const privateKey = Crypto.getRandomBytes(32);
  const device = {
    id: Crypto.randomUUID(),
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(ed25519.getPublicKey(privateKey)),
  };
  await saveSecret(key, JSON.stringify(device));
  return device;
}
export const digestToken = (token: string) => bytesToHex(sha256(utf8ToBytes(token)));
/** Deletes a revoked registration's signing key so the next registration is a new device. */
export async function forgetDevice(userId: string, tenantId: string, deviceId: string) {
  const key = `site.device.${userId}.${tenantId}`;
  const saved = await readSecret(key);
  if (saved && (JSON.parse(saved) as Device).id === deviceId) await deleteSecret(key);
}
export const digestPhoto = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
export function signEvent(device: Device, event: SignedAttendanceEvent, photoBase64: string) {
  return pushAttendanceEventSchema.parse({
    event,
    photoBase64,
    signature: bytesToHex(
      ed25519.sign(utf8ToBytes(canonicalJson(event)), hexToBytes(device.privateKey)),
    ),
  });
}
export function decodeBase64(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error("Invalid camera JPEG.");
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const char of value.replace(/=+$/, "")) {
    accumulator = (accumulator << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}
