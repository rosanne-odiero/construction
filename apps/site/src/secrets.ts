import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Generation pointer is written last; a killed write cannot replace a complete credential. */
export async function saveSecret(name: string, value: string): Promise<void> {
  const previous = await SecureStore.getItemAsync(name, options);
  const generation = Crypto.randomUUID();
  const count = Math.ceil(value.length / 900);
  for (let index = 0; index < count; index++) {
    await SecureStore.setItemAsync(
      `${name}.${generation}.${index}`,
      value.slice(index * 900, (index + 1) * 900),
      options,
    );
  }
  await SecureStore.setItemAsync(name, JSON.stringify({ generation, count }), options);
  if (previous) await removeGeneration(name, previous);
}

async function removeGeneration(name: string, pointer: string) {
  const { generation, count } = JSON.parse(pointer) as { generation: string; count: number };
  for (let index = 0; index < count; index++) {
    await SecureStore.deleteItemAsync(`${name}.${generation}.${index}`, options);
  }
}

export async function readSecret(name: string): Promise<string | null> {
  const pointer = await SecureStore.getItemAsync(name, options);
  if (!pointer) return null;
  const { generation, count } = JSON.parse(pointer) as { generation: string; count: number };
  if (!Number.isInteger(count) || count < 0 || count > 100)
    throw new Error("Secure storage is damaged.");
  let value = "";
  for (let index = 0; index < count; index++) {
    const chunk = await SecureStore.getItemAsync(`${name}.${generation}.${index}`, options);
    if (chunk === null)
      throw new Error("Secure credential is incomplete. Sign in again; outbox is preserved.");
    value += chunk;
  }
  return value;
}

export async function deleteSecret(name: string): Promise<void> {
  const pointer = await SecureStore.getItemAsync(name, options);
  await SecureStore.deleteItemAsync(name, options);
  if (pointer) await removeGeneration(name, pointer);
}
