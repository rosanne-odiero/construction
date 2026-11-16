import React, { useEffect, useRef, useState } from "react";
import {
  AppState,
  BackHandler,
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Crypto from "expo-crypto";
import NetInfo from "@react-native-community/netinfo";
import {
  registerSiteDeviceSchema,
  siteLeaseRequestSchema,
  siteRosterSchema,
  workerCardTokenSchema,
  pushAttendanceEventSchema,
  siteDeviceResponseSchema,
  workerCardResponseSchema,
  type SignedAttendanceEvent,
  type TenantsResponse,
} from "@pm-buddy/validation";
import { Api } from "./api";
import { leaseClock } from "./clock";
import {
  assertLease,
  isDeviceRevoked,
  sameIdentity,
  Synchronizer,
  type Clock,
  type Identity,
  type QueueEntry,
  type QueueStatus,
  type Snapshot,
} from "./core";
import { deviceFor, digestToken, forgetDevice, signEvent, type Device } from "./crypto";
import { PmbSite, type LockTaskState } from "../modules/pmb-site";
import { openStore } from "./native-storage";
import { Store } from "./store";
import {
  cancelNfc,
  optionalPosition,
  preparePhoto,
  readNfcToken,
  requestLocationPermission,
} from "./media";
import { messages } from "./i18n";
import { deleteSecret, readSecret, saveSecret } from "./secrets";

type Candidate = {
  workerId: string;
  workerName: string;
  token: string;
  digest: string;
  method: "qr_card" | "nfc_card";
  checkpoint: string;
  photo: { base64: string; sha256: string; monotonicMs: number } | null;
};
type LockedOwner = { userId: string; tenantId: string; identifier: string };
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Operation failed. Please retry.";
const PROCESS_BOOT_ID = Crypto.randomUUID();
const clock: () => Clock = leaseClock({
  platform: Platform.OS,
  native: PmbSite,
  processBootId: PROCESS_BOOT_ID,
});
const pinning = Platform.OS === "android" ? PmbSite : null;
function currentBootId(): string | null {
  try {
    return clock().bootId;
  } catch {
    return null;
  }
}

function Button({
  title,
  onPress,
  disabled = false,
  selected = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      style={[styles.button, selected && styles.selected, disabled && styles.disabled]}
      onPress={onPress}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  set,
  secret = false,
  numeric = false,
}: {
  label: string;
  value: string;
  set: (value: string) => void;
  secret?: boolean;
  numeric?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={set}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={numeric ? "number-pad" : "default"}
        style={styles.input}
      />
    </View>
  );
}

export default function App() {
  const [language, setLanguage] = useState<"en" | "sw">("en");
  const t = messages[language];
  const apiRef = useRef<Api | null>(null);
  const storeRef = useRef<Store | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const syncRef = useRef(new Synchronizer());
  const busyRef = useRef(false);
  const mounted = useRef(true);
  // Android pauses the app behind a system permission dialog; that pause must not discard a scan.
  const promptRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(false);
  const [, rerender] = useState(0);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [tenants, setTenants] = useState<TenantsResponse["tenants"]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [counts, setCounts] = useState<Partial<Record<QueueStatus, number>>>({});
  const [projectId, setProjectId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [lockedOwner, setLockedOwner] = useState<LockedOwner | null>(null);
  const lockedOwnerRef = useRef<LockedOwner | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockMfa, setUnlockMfa] = useState(false);
  const [cameraMode, setCameraMode] = useState<"qr" | "photo" | null>(null);
  const camera = useRef<CameraView>(null);
  const scanGate = useRef(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [confirmed, setConfirmed] = useState(false);
  const [position, setPosition] = useState<SignedAttendanceEvent["position"]>(null);
  const [nfcActive, setNfcActive] = useState(false);
  const [deviceName, setDeviceName] = useState(Platform.OS === "ios" ? "Site iOS" : "Site Android");
  const [adminWorker, setAdminWorker] = useState("");
  const [cardId, setCardId] = useState("");
  const [deviceIdToRevoke, setDeviceIdToRevoke] = useState("");
  const [issuedCard, setIssuedCard] = useState<{ id: string; token: string } | null>(null);
  const [revoked, setRevoked] = useState<{ unsynced: number; synced: number } | null>(null);
  const [pinState, setPinState] = useState<LockTaskState>("none");
  const api = apiRef.current;
  const auth = api?.auth;
  const project = snapshot?.roster.projects.find((item) => item.id === projectId);

  function identity(): Identity | null {
    const active = apiRef.current?.auth;
    const device = deviceRef.current;
    if (!active || active.mfaRequired || !active.session.tenantId || !device) return null;
    const value = {
      userId: active.user.id,
      tenantId: active.session.tenantId,
      deviceId: device.id,
    };
    const locked = lockedOwnerRef.current;
    if (locked && (locked.userId !== value.userId || locked.tenantId !== value.tenantId))
      return null;
    return value;
  }
  async function loadScope() {
    const active = apiRef.current?.auth;
    if (!active || active.mfaRequired || !active.session.tenantId) {
      deviceRef.current = null;
      setSnapshot(null);
      setEntries([]);
      setCounts({});
      return;
    }
    deviceRef.current = await deviceFor(active.user.id, active.session.tenantId);
    const owner = identity();
    const store = storeRef.current;
    if (!owner || !store) {
      setSnapshot(null);
      setEntries([]);
      setCounts({});
      return;
    }
    setSnapshot(await store.snapshot(owner));
    setEntries(await store.entries(owner, true));
    setCounts(await store.counts(owner));
  }
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      try {
        await loadScope();
      } catch (failure) {
        setError(errorText(failure));
        setReady(false);
      }
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        rerender((value) => value + 1);
      }
    }
  }
  async function syncNow() {
    const client = apiRef.current;
    const store = storeRef.current;
    const before = identity();
    if (!client || !store || !before)
      throw new Error("Sign in and select a company before syncing.");
    await client.refresh();
    const after = identity();
    if (!after || !sameIdentity(before, after))
      throw new Error("Session changed. Outbox retained.");
    try {
      await syncRef.current.run(store, identity, async (payload) => {
        const parsed = pushAttendanceEventSchema.parse(JSON.parse(payload));
        if (
          parsed.event.deviceId !== before.deviceId ||
          parsed.event.tenantId !== before.tenantId
        ) {
          throw new Error("Outbox scope mismatch; sync stopped.");
        }
        return client.push(payload);
      });
    } catch (failure) {
      if (!isDeviceRevoked(failure)) throw failure;
      await eraseRevoked(before);
      return;
    }
    setNotice(
      "Sync batch complete (up to 25). More pending events sync automatically. Quarantined events require office review.",
    );
  }
  /** Only after the server states this registration is revoked (THREAT_MODEL T-38). */
  async function eraseRevoked(owner: Identity) {
    const store = storeRef.current;
    if (!store) throw new Error("Encrypted storage unavailable.");
    const erased = await store.purge(owner);
    await forgetDevice(owner.userId, owner.tenantId, owner.deviceId);
    if (deviceRef.current?.id === owner.deviceId) deviceRef.current = null;
    resetCapture();
    setIssuedCard(null);
    setRevoked(erased);
  }
  function watchPin() {
    if (!pinning) return;
    let attempts = 0;
    const timer = setInterval(() => {
      const state = pinning.lockTaskState();
      if (mounted.current) setPinState(state);
      if (state !== "none" || ++attempts >= 60 || !mounted.current) clearInterval(timer);
    }, 1_000);
  }
  async function pin() {
    if (!pinning) return;
    try {
      await pinning.startLockTask();
    } catch (failure) {
      setError(`Screen pinning unavailable: ${errorText(failure)}`);
    } finally {
      setPinState(pinning.lockTaskState());
      // The system confirmation is answered after the call returns.
      watchPin();
    }
  }
  async function unpin() {
    if (!pinning) return;
    try {
      await pinning.stopLockTask();
    } catch (failure) {
      setError(`Unpin the screen manually: ${errorText(failure)}`);
    } finally {
      setPinState(pinning.lockTaskState());
    }
  }
  useEffect(() => {
    mounted.current = true;
    void run(async () => {
      const client = new Api();
      apiRef.current = client;
      storeRef.current = await openStore();
      await client.restore();
      const savedLock = await readSecret("site.kiosk");
      if (savedLock) {
        const lock = JSON.parse(savedLock) as {
          owner: LockedOwner;
          projectId: string;
          siteId: string;
        };
        lockedOwnerRef.current = lock.owner;
        setLockedOwner(lock.owner);
        setProjectId(lock.projectId);
        setSiteId(lock.siteId);
        await pin();
      }
      await loadScope();
      setReady(true);
    });
    const unsubscribe = NetInfo.addEventListener((state) => {
      setOnline(state.isConnected === true && state.isInternetReachable !== false);
    });
    let previous = AppState.currentState;
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !promptRef.current) {
        setCameraMode(null);
        setCandidate(null);
        setConfirmed(false);
        setPosition(null);
      }
      if (state === "background") {
        void cancelNfc().catch((failure: unknown) => setError(errorText(failure)));
      }
      // Re-pin after leaving a locked kiosk; never re-prompt on the pinning dialog itself.
      if (state === "active" && previous === "background" && lockedOwnerRef.current) void pin();
      previous = state;
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      app.remove();
    };
  }, []);
  useEffect(() => {
    if (online && ready && identity()) void run(syncNow);
    const timer = setInterval(() => {
      if (pinning) setPinState(pinning.lockTaskState());
      if (online && ready && !busyRef.current && identity()) void run(syncNow);
    }, 30_000);
    return () => clearInterval(timer);
  }, [online, ready, auth?.user.id, auth?.session.tenantId, lockedOwner]);
  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (lockedOwner) {
        if (cameraMode) setCameraMode(null);
        else setUnlocking(true);
        return true;
      }
      return false;
    });
    return () => handler.remove();
  }, [lockedOwner, cameraMode]);

  function resetCapture() {
    setCandidate(null);
    setConfirmed(false);
    setPosition(null);
    setCameraMode(null);
    setCameraReady(false);
    scanGate.current = false;
  }
  function guard() {
    const owner = identity();
    const store = storeRef.current;
    const device = deviceRef.current;
    if (!ready || !store || !owner || !device || !snapshot)
      throw new Error("Storage, supervisor session or roster unavailable.");
    assertLease(snapshot.roster.lease, owner, clock());
    if (!project?.sites.some((site) => site.id === siteId))
      throw new Error("Select a leased project and site.");
    return { owner, store, device, snapshot };
  }
  async function scan(token: string, method: "qr_card" | "nfc_card") {
    guard();
    await storeRef.current!.health();
    const value = workerCardTokenSchema.parse(token);
    const digest = digestToken(value);
    const worker = project?.workers.find((item) => item.cardDigest === digest);
    if (!worker || !snapshot)
      throw new Error("Card not found in this project roster. Renew online or contact the office.");
    setCandidate({
      workerId: worker.id,
      workerName: worker.name,
      token: value,
      digest,
      method,
      checkpoint: snapshot.checkpoint,
      photo: null,
    });
    setConfirmed(false);
    setPosition(null);
    setCameraMode(null);
    setNotice(
      "Named worker resolved. A fresh photo and explicit supervisor confirmation are required.",
    );
  }
  async function withPrompt<T>(request: () => Promise<T>): Promise<T> {
    promptRef.current = true;
    try {
      return await request();
    } finally {
      promptRef.current = false;
    }
  }
  async function openCamera(mode: "qr" | "photo") {
    guard();
    await storeRef.current!.health();
    if (!(permission?.granted || (await withPrompt(requestPermission)).granted))
      throw new Error("Camera permission required; no gallery alternative.");
    scanGate.current = false;
    setCameraReady(false);
    setCameraMode(mode);
  }
  async function takePhoto() {
    guard();
    if (!candidate || !camera.current || !cameraReady) throw new Error("Camera is not ready.");
    const result = await camera.current.takePictureAsync({ quality: 0.6, skipProcessing: false });
    if (!result?.uri) throw new Error("No photo captured. Please retake.");
    const photo = await preparePhoto(result.uri);
    setCandidate({ ...candidate, photo: { ...photo, monotonicMs: clock().monotonicMs } });
    setCameraMode(null);
    setConfirmed(false);
  }
  async function saveCapture() {
    const { owner, store, device, snapshot: currentSnapshot } = guard();
    if (!candidate?.photo || !confirmed)
      throw new Error("Take a fresh photo and explicitly confirm the named worker.");
    if (clock().monotonicMs - candidate.photo.monotonicMs > 120_000)
      throw new Error("Photo is older than two minutes. Retake it.");
    await store.capture({
      identity: owner,
      clock,
      id: Crypto.randomUUID(),
      newShiftId: Crypto.randomUUID(),
      projectId,
      siteId,
      workerId: candidate.workerId,
      cardDigest: candidate.digest,
      cardToken: candidate.token,
      method: candidate.method,
      direction,
      photoBase64: candidate.photo.base64,
      photoSha256: candidate.photo.sha256,
      position,
      checkpoint: candidate.checkpoint,
      sign: (event, photo) => signEvent(device, event, photo),
    });
    if (candidate.checkpoint !== currentSnapshot.checkpoint)
      throw new Error("Roster changed unexpectedly; inspect outbox before retrying.");
    resetCapture();
    setNotice("Saved durably on this encrypted device. Pending sync is not server confirmation.");
    // Saving is independent of connectivity; a failed network never rolls the durable capture back.
  }
  async function renew() {
    const owner = identity();
    const store = storeRef.current;
    const device = deviceRef.current;
    if (!owner || !store || !device || !api)
      throw new Error("Select a company and complete sign-in.");
    await store.health();
    await api.refresh();
    const registration = registerSiteDeviceSchema.parse({
      id: device.id,
      name: deviceName,
      publicKey: device.publicKey,
    });
    let roster;
    let request;
    try {
      const response = siteDeviceResponseSchema.parse(
        await api.request("attendance/capture/devices", "POST", registration),
      );
      if (
        response.device?.id !== device.id ||
        response.device.publicKey !== device.publicKey ||
        response.device.revokedAt
      ) {
        throw new Error("Server device registration mismatch or device revoked.");
      }
      const anchor = clock();
      request = siteLeaseRequestSchema.parse({
        bootId: anchor.bootId,
        deviceTime: new Date(anchor.wallMs).toISOString(),
        monotonicMs: anchor.monotonicMs,
      });
      roster = siteRosterSchema.parse(
        await api.request(`attendance/capture/devices/${device.id}/lease`, "POST", request),
      );
    } catch (failure) {
      if (!isDeviceRevoked(failure)) throw failure;
      await eraseRevoked(owner);
      return;
    }
    if (
      roster.lease.bootId !== request.bootId ||
      roster.lease.monotonicMs !== request.monotonicMs ||
      roster.lease.deviceTime !== request.deviceTime
    )
      throw new Error("Lease anchor mismatch.");
    const current = identity();
    if (!current || !sameIdentity(current, owner))
      throw new Error("Identity changed during roster pull.");
    await store.install(owner, roster, Crypto.randomUUID(), clock);
    resetCapture();
    setNotice("Full roster and lease checkpoint saved atomically. Pending captures were retained.");
  }
  async function unlock() {
    if (!lockedOwner || !api) throw new Error("No locked supervisor.");
    const owner = lockedOwner;
    try {
      const response = await api.login(owner.identifier, password, owner.userId, owner.tenantId);
      if (response?.mfaRequired) {
        setUnlockMfa(true);
        return;
      }
      await deleteSecret("site.kiosk");
      lockedOwnerRef.current = null;
      setLockedOwner(null);
      setUnlocking(false);
      setUnlockMfa(false);
      resetCapture();
      await unpin();
    } finally {
      setPassword("");
    }
  }
  async function unlockWithMfa() {
    if (!api || !lockedOwner) throw new Error("No locked supervisor.");
    try {
      const response = await api.stepUp(code);
      if (response.user.id !== lockedOwner.userId) throw new Error("Supervisor mismatch.");
      await api.select(lockedOwner.tenantId);
      await deleteSecret("site.kiosk");
      lockedOwnerRef.current = null;
      setLockedOwner(null);
      setUnlocking(false);
      setUnlockMfa(false);
      resetCapture();
      await unpin();
    } finally {
      setCode("");
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.row}>
          <Text accessibilityRole="header" style={styles.title}>
            {t.title}
          </Text>
          <Button
            title={language === "en" ? "Kiswahili" : "English"}
            onPress={() => setLanguage(language === "en" ? "sw" : "en")}
          />
        </View>
        <Text>
          {online ? t.online : t.offline} {busy ? " · Working…" : ""}
        </Text>
        {!!error && (
          <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error}>
            {error}
          </Text>
        )}
        {!!notice && (
          <Text accessibilityLiveRegion="polite" style={styles.notice}>
            {notice}
          </Text>
        )}
        {revoked && (
          <View style={styles.panel}>
            <Text accessibilityRole="alert" style={styles.error}>
              {t.revoked
                .replace("{unsynced}", String(revoked.unsynced))
                .replace("{synced}", String(revoked.synced))}
            </Text>
            <Button title={t.dismiss} onPress={() => setRevoked(null)} />
          </View>
        )}
        {!ready && (
          <Text>
            Encrypted storage must open successfully before any capture. Restart the native build
            after correcting the displayed error. Never clear app data with an unsynced outbox.
          </Text>
        )}

        {ready && lockedOwner && unlocking ? (
          <View style={styles.panel}>
            <Text style={styles.heading}>{t.unlock}</Text>
            <Text>Online password re-authentication is required. No biometric bypass.</Text>
            {!unlockMfa ? (
              <>
                <Field label={t.password} value={password} set={setPassword} secret />
                <Button
                  title={t.exit}
                  disabled={busy || !password}
                  onPress={() => void run(unlock)}
                />
              </>
            ) : (
              <>
                <Field label={t.mfa} value={code} set={setCode} numeric />
                <Button
                  title={t.verify}
                  disabled={busy || !code}
                  onPress={() => void run(unlockWithMfa)}
                />
              </>
            )}
            <Button
              title={t.cancel}
              disabled={busy || !identity()}
              onPress={() => {
                setUnlocking(false);
                setPassword("");
                setCode("");
                setUnlockMfa(false);
              }}
            />
          </View>
        ) : ready && !lockedOwner && (!auth || auth.mfaRequired) ? (
          <View style={styles.panel}>
            {!auth ? (
              <>
                <Field label={t.identifier} value={identifier} set={setIdentifier} />
                <Field label={t.password} value={password} set={setPassword} secret />
                <Button
                  title={t.login}
                  disabled={busy || !identifier || !password}
                  onPress={() =>
                    void run(async () => {
                      try {
                        await api!.login(identifier, password);
                        setTenants([]);
                        setProjectId("");
                        setSiteId("");
                      } finally {
                        setPassword("");
                      }
                    })
                  }
                />
              </>
            ) : (
              <>
                <Field label={t.mfa} value={code} set={setCode} numeric />
                <Button
                  title={t.verify}
                  disabled={busy || !code}
                  onPress={() =>
                    void run(async () => {
                      try {
                        await api!.stepUp(code);
                      } finally {
                        setCode("");
                      }
                    })
                  }
                />
                {!auth.user.totpEnabled && (
                  <Text>
                    This native client needs an authenticator code. Configure TOTP using the office
                    app; passkeys do not bypass MFA here.
                  </Text>
                )}
                <Button
                  title={t.logout}
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await api!.logout();
                    })
                  }
                />
              </>
            )}
          </View>
        ) : ready && !lockedOwner && auth ? (
          <>
            <Text style={styles.heading}>{auth.user.displayName}</Text>
            <Button
              title={t.company}
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  setTenants(await api!.tenants());
                })
              }
            />
            {tenants.map((tenant) => (
              <Button
                key={tenant.id}
                title={tenant.name}
                selected={auth.session.tenantId === tenant.id}
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    resetCapture();
                    setProjectId("");
                    setSiteId("");
                    setIssuedCard(null);
                    await api!.select(tenant.id);
                    setTenants([]);
                  })
                }
              />
            ))}
            {auth.session.tenantId && (
              <>
                <Text selectable>Device: {deviceRef.current?.id}</Text>
                <Field label="Device name / Jina la kifaa" value={deviceName} set={setDeviceName} />
                <Button title={t.renew} disabled={busy} onPress={() => void run(renew)} />
                {snapshot && (
                  <Text>
                    Lease: {snapshot.roster.lease.expiresAt} ·{" "}
                    {snapshot.roster.lease.bootId === currentBootId()
                      ? "current boot"
                      : "RENEW AFTER RESTART"}
                  </Text>
                )}
                <Text style={styles.heading}>{t.project}</Text>
                {snapshot?.roster.projects.map((item) => (
                  <Button
                    key={item.id}
                    title={item.name}
                    selected={projectId === item.id}
                    disabled={busy}
                    onPress={() => {
                      setProjectId(item.id);
                      setSiteId("");
                      setAdminWorker("");
                      setIssuedCard(null);
                      resetCapture();
                    }}
                  />
                ))}
                <Text style={styles.heading}>{t.site}</Text>
                {project?.sites.map((site) => (
                  <Button
                    key={site.id}
                    title={site.name}
                    selected={siteId === site.id}
                    disabled={busy}
                    onPress={() => {
                      setSiteId(site.id);
                      resetCapture();
                    }}
                  />
                ))}
                <Button
                  title={t.enter}
                  disabled={busy || !siteId}
                  onPress={() =>
                    void run(async () => {
                      guard();
                      await storeRef.current!.health();
                      resetCapture();
                      const owner = {
                        userId: auth.user.id,
                        tenantId: auth.session.tenantId!,
                        identifier: auth.user.identifier,
                      };
                      await saveSecret("site.kiosk", JSON.stringify({ owner, projectId, siteId }));
                      lockedOwnerRef.current = owner;
                      setLockedOwner(owner);
                      await pin();
                    })
                  }
                />
                <View style={styles.panel}>
                  <Text style={styles.heading}>{t.admin}</Text>
                  <Text>
                    Use office permissions; server enforces step-up. Issue cards only to the named
                    worker. Tokens are shown only here for controlled card provisioning.
                  </Text>
                  <Field label={t.mfa} value={code} set={setCode} numeric />
                  <Button
                    title={t.verify}
                    disabled={busy || !code}
                    onPress={() =>
                      void run(async () => {
                        try {
                          await api!.stepUp(code);
                        } finally {
                          setCode("");
                        }
                      })
                    }
                  />
                  {project?.workers.map((worker) => (
                    <Button
                      key={worker.id}
                      title={worker.name}
                      selected={adminWorker === worker.id}
                      disabled={busy}
                      onPress={() => {
                        setAdminWorker(worker.id);
                        setIssuedCard(null);
                      }}
                    />
                  ))}
                  <Button
                    title="Issue selected worker card / Toa kadi"
                    disabled={busy || !adminWorker}
                    onPress={() =>
                      void run(async () => {
                        const response = workerCardResponseSchema.parse(
                          await api!.request("attendance/capture/cards", "POST", {
                            labourerId: adminWorker,
                          }),
                        );
                        if (response.card.labourerId !== adminWorker)
                          throw new Error("Issued card worker mismatch.");
                        setIssuedCard({
                          id: response.card.id,
                          token: workerCardTokenSchema.parse(response.card.token),
                        });
                        setCardId(response.card.id);
                        setNotice(
                          "Card issued. Renew the roster on every capture device before use.",
                        );
                      })
                    }
                  />
                  {issuedCard && (
                    <Text selectable>
                      Card {issuedCard.id}
                      {"\n"}
                      {issuedCard.token}
                    </Text>
                  )}
                  <Field
                    label="Card ID to revoke / Kadi ya kufuta"
                    value={cardId}
                    set={setCardId}
                  />
                  <Button
                    title="Revoke card / Futa kadi"
                    disabled={busy || !cardId}
                    onPress={() =>
                      void run(async () => {
                        if (!/^[0-9a-f-]{36}$/i.test(cardId)) throw new Error("Enter a card UUID.");
                        await api!.request(`attendance/capture/cards/${cardId}/revoke`, "POST");
                        setIssuedCard(null);
                        setCardId("");
                        setNotice("Card revoked. Renew all capture device rosters.");
                      })
                    }
                  />
                  <Field
                    label="Device ID to revoke / Kifaa cha kufuta"
                    value={deviceIdToRevoke}
                    set={setDeviceIdToRevoke}
                  />
                  <Button
                    title="Revoke device / Futa kifaa"
                    disabled={busy || !deviceIdToRevoke}
                    onPress={() =>
                      void run(async () => {
                        if (!/^[0-9a-f-]{36}$/i.test(deviceIdToRevoke))
                          throw new Error("Enter a device UUID.");
                        const self = deviceIdToRevoke === deviceRef.current?.id ? identity() : null;
                        if (self) {
                          const local = await storeRef.current!.counts(self);
                          const unsynced =
                            (local.pending ?? 0) + (local.failed ?? 0) + (local.conflicted ?? 0);
                          if (unsynced)
                            throw new Error(
                              `Sync first: revoking this phone erases ${unsynced} unsynced capture(s). Revoke a lost phone from the office instead.`,
                            );
                        }
                        await api!.request(
                          `attendance/capture/devices/${deviceIdToRevoke}/revoke`,
                          "POST",
                        );
                        if (self) await eraseRevoked(self);
                        setDeviceIdToRevoke("");
                        setNotice(
                          "Device revoked. It erases its roster and captures when it next connects.",
                        );
                      })
                    }
                  />
                </View>
              </>
            )}
            <Button
              title={t.refresh}
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  await api!.refresh();
                })
              }
            />
            <Button
              title={t.logout}
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  await api!.logout();
                  resetCapture();
                  setProjectId("");
                  setSiteId("");
                  setTenants([]);
                  setIssuedCard(null);
                })
              }
            />
          </>
        ) : ready && lockedOwner ? (
          <View style={styles.panel}>
            <Text style={styles.heading}>
              {project?.name} · {project?.sites.find((site) => site.id === siteId)?.name}
            </Text>
            {pinning && <Text>{pinState === "none" ? t.unpinned : t.pinned}</Text>}
            <View style={styles.row}>
              <Button
                title={t.directionIn}
                selected={direction === "in"}
                disabled={busy || !!candidate}
                onPress={() => setDirection("in")}
              />
              <Button
                title={t.directionOut}
                selected={direction === "out"}
                disabled={busy || !!candidate}
                onPress={() => setDirection("out")}
              />
            </View>
            {!cameraMode && !candidate && (
              <>
                <Button
                  title={t.scan}
                  disabled={busy}
                  onPress={() => void run(() => openCamera("qr"))}
                />
                <Button
                  title={t.nfc}
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      guard();
                      await storeRef.current!.health();
                      setNfcActive(true);
                      try {
                        await scan(await readNfcToken(), "nfc_card");
                      } finally {
                        setNfcActive(false);
                      }
                    })
                  }
                />
              </>
            )}
            {nfcActive && (
              <Button
                title="Cancel NFC / Ghairi NFC"
                onPress={() => {
                  void cancelNfc().catch((failure: unknown) => setError(errorText(failure)));
                }}
              />
            )}
            {!!cameraMode && (
              <View>
                <Text>{cameraMode === "qr" ? t.scan : `${t.photo}: ${candidate?.workerName}`}</Text>
                <CameraView
                  ref={camera}
                  style={styles.camera}
                  facing="back"
                  mode="picture"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onCameraReady={() => setCameraReady(true)}
                  onMountError={(failure) => {
                    setError(failure.message);
                    setCameraMode(null);
                  }}
                  onBarcodeScanned={
                    cameraMode === "qr"
                      ? ({ data }) => {
                          if (scanGate.current || busyRef.current) return;
                          scanGate.current = true;
                          void run(async () => {
                            await scan(data, "qr_card");
                          });
                        }
                      : undefined
                  }
                />
                {cameraMode === "photo" && (
                  <Button
                    title={t.photo}
                    disabled={busy || !cameraReady}
                    onPress={() => void run(takePhoto)}
                  />
                )}
                <Button title={t.cancel} disabled={busy} onPress={() => setCameraMode(null)} />
              </View>
            )}
            {candidate && !cameraMode && (
              <>
                <Text accessibilityRole="header" style={styles.worker}>
                  {candidate.workerName}
                </Text>
                <Text>{direction === "in" ? t.directionIn : t.directionOut}</Text>
                {candidate.photo && (
                  <Image
                    accessibilityLabel={`Fresh photo: ${candidate.workerName}`}
                    source={{ uri: `data:image/jpeg;base64,${candidate.photo.base64}` }}
                    style={styles.photo}
                  />
                )}
                <Button
                  title={t.photo}
                  disabled={busy}
                  onPress={() => void run(() => openCamera("photo"))}
                />
                <Text>{position ? `GPS ±${Math.round(position.accuracyM)}m` : t.missing}</Text>
                <Button
                  title={t.location}
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      // Location settings can also open a system activity while it resolves.
                      await withPrompt(async () => {
                        await requestLocationPermission();
                        setPosition(await optionalPosition());
                      });
                    })
                  }
                />
                {position && (
                  <Button title={t.missing} disabled={busy} onPress={() => setPosition(null)} />
                )}
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={t.confirm}
                  accessibilityState={{ checked: confirmed }}
                  disabled={busy || !candidate.photo}
                  style={styles.confirm}
                  onPress={() => setConfirmed(!confirmed)}
                >
                  <Text>
                    {confirmed ? "☑" : "☐"} {t.confirm}: {candidate.workerName}
                  </Text>
                </Pressable>
                <Button
                  title={t.save}
                  disabled={busy || !candidate.photo || !confirmed}
                  onPress={() => void run(saveCapture)}
                />
                <Button title={t.clear} disabled={busy} onPress={resetCapture} />
              </>
            )}
            <Button
              title={t.exit}
              disabled={busy}
              onPress={() => {
                setPassword("");
                setUnlocking(true);
              }}
            />
          </View>
        ) : null}

        {ready && identity() && (
          <View style={styles.panel}>
            <Text accessibilityRole="header" style={styles.heading}>
              {t.queue}
            </Text>
            <Text>
              Only this supervisor / company / device. Other outboxes remain encrypted and are never
              transmitted under this session.
            </Text>
            <Text>
              {Object.entries(counts)
                .map(([status, count]) => `${t[status as QueueStatus]}: ${count}`)
                .join(" · ")}
            </Text>
            <Button title={t.retry} disabled={busy} onPress={() => void run(syncNow)} />
            {!lockedOwner && !!counts.conflicted && (
              <Button
                title="Retry conflicts unchanged / Jaribu migogoro tena"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    await storeRef.current!.retryConflicts(identity()!);
                    await syncNow();
                  })
                }
              />
            )}
            <Text>
              Showing the latest 30 captures; all older captures and receipts remain encrypted on
              device.
            </Text>
            {entries.length === 0 && <Text>No captures on this scope.</Text>}
            {entries
              .slice(-30)
              .reverse()
              .map((entry) => (
                <View key={entry.id} style={styles.queueEntry}>
                  <Text>
                    {entry.id.slice(0, 8)} · {t[entry.status]}
                  </Text>
                  {entry.receipt && (
                    <Text>{entry.receipt.flags.join(", ") || "No review flags"}</Text>
                  )}
                  {entry.error && <Text style={styles.error}>{entry.error}</Text>}
                </View>
              ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f2f5f6" },
  content: { padding: 18, gap: 12, paddingBottom: 48 },
  title: { fontSize: 23, fontWeight: "700", color: "#12333c", flexShrink: 1 },
  heading: { fontSize: 19, fontWeight: "700", color: "#12333c" },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  button: {
    minHeight: 48,
    backgroundColor: "#145767",
    borderRadius: 8,
    padding: 13,
    justifyContent: "center",
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600", textAlign: "center" },
  selected: { backgroundColor: "#18342b", borderWidth: 3, borderColor: "#7ecdb2" },
  disabled: { opacity: 0.45 },
  field: { gap: 5 },
  label: { fontSize: 16, color: "#12333c" },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#6d8388",
    borderRadius: 6,
    backgroundColor: "#fff",
    padding: 12,
    fontSize: 17,
  },
  error: { color: "#981d22", fontSize: 16 },
  notice: { color: "#155137", fontSize: 16 },
  panel: { padding: 14, gap: 12, backgroundColor: "#fff", borderRadius: 10 },
  camera: { height: 330, marginVertical: 12 },
  photo: { width: 180, height: 240, resizeMode: "contain" },
  worker: { fontSize: 29, fontWeight: "800", color: "#12333c" },
  confirm: { padding: 16, minHeight: 60, borderWidth: 2, borderRadius: 7, borderColor: "#145767" },
  queueEntry: { borderBottomWidth: 1, borderColor: "#c5d5da", paddingVertical: 10, gap: 4 },
});
