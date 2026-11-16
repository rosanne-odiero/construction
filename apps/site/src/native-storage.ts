import * as SQLite from "expo-sqlite";
import * as Crypto from "expo-crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readSecret, saveSecret } from "./secrets";
import { Store } from "./store";
import { serializeDatabase } from "./database";

export async function openStore(): Promise<Store> {
  let key = await readSecret("site.sqlcipher.key");
  if (!key) {
    key = bytesToHex(Crypto.getRandomBytes(32));
    await saveSecret("site.sqlcipher.key", key);
  }
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new Error("Invalid encrypted storage key. Do not clear app data.");
  const db = await SQLite.openDatabaseAsync("site-attendance.db", { useNewConnection: true });
  // Key precedes all reads; never fall back to plaintext if the native SQLCipher build is missing.
  await db.execAsync(`PRAGMA key = "x'${key}'";`);
  const cipher = await db.getFirstAsync<Record<string, unknown>>("PRAGMA cipher_version");
  if (!cipher || !Object.values(cipher)[0]) {
    await db.closeAsync();
    throw new Error("SQLCipher is unavailable. Install the native development build, not Expo Go.");
  }
  // Expo's built-in exclusive transaction opens an unkeyed second connection.
  const store = new Store(serializeDatabase(db));
  await store.initialize();
  return store;
}
