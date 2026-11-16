import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import * as Location from "expo-location";
import NfcManager, { Ndef, NfcTech } from "react-native-nfc-manager";
import { Platform } from "react-native";
import { workerCardTokenSchema, type SignedAttendanceEvent } from "@pm-buddy/validation";
import { decodeBase64, digestPhoto } from "./crypto";
import { NfcReader } from "./nfc";

export async function preparePhoto(uri: string) {
  let base64: string | undefined;
  const generated: string[] = [];
  try {
    for (const [width, compress] of [
      [240, 0.55],
      [200, 0.35],
      [160, 0.2],
    ] as const) {
      const context = ImageManipulator.manipulate(uri);
      context.resize({ width });
      const image = await context.renderAsync();
      const result = await image.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
      generated.push(result.uri);
      base64 = result.base64;
      context.release();
      image.release();
      if (base64 && decodeBase64(base64).length <= 36 * 1_024) break;
    }
    if (!base64) throw new Error("Camera returned no JPEG.");
    const bytes = decodeBase64(base64);
    if (bytes.length > 36 * 1_024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error("Photo is not a small JPEG. Retake the photo.");
    }
    return { base64, sha256: digestPhoto(bytes) };
  } finally {
    for (const path of new Set([uri, ...generated])) {
      const file = new File(path);
      if (file.exists) file.delete();
    }
  }
}

export async function requestLocationPermission(): Promise<void> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted)
    throw new Error("Location denied. Capture can continue with location explicitly missing.");
}

export async function optionalPosition(): Promise<SignedAttendanceEvent["position"]> {
  // Request permission first (requestLocationPermission); re-requesting reopens a system activity.
  if (!(await Location.getForegroundPermissionsAsync()).granted)
    throw new Error("Location denied. Capture can continue with location explicitly missing.");
  const position = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Location timed out. Use location missing or retry.")),
        12_000,
      ),
    ),
  ]);
  if (position.coords.accuracy === null)
    throw new Error("Location accuracy unknown. Use location missing or retry.");
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracyM: position.coords.accuracy,
  };
}

const nfcReader = new NfcReader(
  {
    isSupported: () => NfcManager.isSupported(),
    start: () => NfcManager.start(),
    isEnabled: () => NfcManager.isEnabled(),
    request: () =>
      NfcManager.requestTechnology(NfcTech.Ndef, {
        alertMessage: "Hold the worker's PM Buddy card near the top of your iPhone.",
      }),
    token: async () => {
      const tag = await NfcManager.getTag();
      const text = tag?.ndefMessage
        ?.filter(
          (record) =>
            record.tnf === Ndef.TNF_WELL_KNOWN &&
            (typeof record.type === "string"
              ? record.type === "T"
              : record.type.length === 1 && record.type[0] === 84),
        )
        .map((record) => Ndef.text.decodePayload(Uint8Array.from(record.payload)));
      if (!text || text.length !== 1)
        throw new Error("NFC card must contain exactly one NDEF text record.");
      return workerCardTokenSchema.parse(text[0]);
    },
    cancel: () => NfcManager.cancelTechnologyRequest(),
  },
  Platform.OS === "ios" ? "ios" : "android",
);

export const readNfcToken = () => nfcReader.read();
export const cancelNfc = () => nfcReader.cancel();
