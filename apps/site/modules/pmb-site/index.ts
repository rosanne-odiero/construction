import { requireOptionalNativeModule } from "expo";
import type { BootClockSource } from "../../src/clock";

export type LockTaskState = "none" | "pinned" | "locked";
export type PmbSiteNative = BootClockSource & {
  startLockTask(): Promise<void>;
  stopLockTask(): Promise<void>;
  lockTaskState(): LockTaskState;
};

/** Android-only helpers from this app's local Expo module; null on iOS. */
export const PmbSite = requireOptionalNativeModule<PmbSiteNative>("PmbSite");
