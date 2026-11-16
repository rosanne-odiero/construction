# PM Buddy Site (Android and iOS)

Native attendance capture for D3.2/D3.3. **Expo Go and a browser are not supported.**
SQLCipher and NFC require a custom native development/release build; Metro alone cannot
add these native modules. No production hardware claims are made by the unit tests.

## Prerequisites and development

- Use the workspace's Node >=24 and pnpm version. Run `pnpm install` at the repository root.
- Android Studio, Android SDK, a supported JDK (Expo SDK 55 / React Native 0.83), and
  an Android emulator or USB-debug-enabled physical device. NFC requires real hardware
  and NDEF text cards; camera tests need a real camera.
- For iOS: macOS with full Xcode, its command-line tools selected, CocoaPods and an
  iOS simulator or physical iPhone/iPad. Physical-device builds need Apple signing
  with the NFC reader capability and a matching provisioning profile. NFC requires
  a supported physical iPhone; simulators and devices without NFC use QR.
- An API with the attendance-capture migrations applied, a verified supervisor,
  company membership, project/site access, active worker engagements and issued PMB1 cards.
  Office administrators provision printable QR/NFC card content and review quarantines.
- Build shared packages first:
  `pnpm --filter @pm-buddy/domain build && pnpm --filter @pm-buddy/validation build`.
- Copy `.env.example` to `.env` **inside this directory** and configure:
  - `EXPO_PUBLIC_API_URL`: API version root, e.g. `https://api.example.com/api/v1`.
  - `EXPO_PUBLIC_WEB_ORIGIN`: exact server-configured `WEB_ORIGIN`, independently of
    the API host, e.g. `https://app.example.com`. Do not append a path.
    Neither value is secret. Never put passwords or keys in Expo environment variables.
- From this directory: `pnpm android` (generates/builds native project), then `pnpm dev`
  for subsequent development sessions. Rebuild the native app after plugin changes.
  Generated `android/`, `ios/` and `.expo/` directories are intentionally ignored locally.
- For iOS: `pnpm ios` builds/runs the simulator app; use `pnpm exec expo run:ios --device`
  for a signed physical-device build. Both phones and tablets use the same app-level
  lock, encrypted outbox, lease, device-key binding and sync protocol.

HTTPS is mandatory except **development-only** HTTP on localhost, loopback or Android's
`10.0.2.2`. For an emulator, `adb reverse tcp:4000 tcp:4000` permits localhost API access;
adjust for the actual server port. If Android rejects development cleartext, use a
trusted HTTPS development endpoint rather than weakening a release build's network policy.
LAN HTTP and HTTP in release builds are rejected by the app.

SDK 55 native dependency versions follow Expo's published `bundledNativeModules.json`,
including React 19.2.0 and RN 0.83.10 (not the web app's React version).

## Operator workflow

1. Sign in with email/phone and password, complete authenticator MFA if required,
   select a company, then register the device / renew the full roster and server lease.
2. Select a project and site, and start locked capture. Kiosk lock survives app restart.
   Unlocking requires the original supervisor's online password sign-in (and MFA where
   required); no biometric, offline password cache, or back-button bypass exists.
   On Android, starting locked capture also requests **screen pinning** (the system asks
   "Pin app?"); the app re-requests it after returning from the background and releases it
   only after the supervisor re-authenticates. Without a device owner/MDM that allow-lists
   `ke.co.pmbuddy.site`, the system unpin gesture still works, so this is **not** enforced
   lock-task management; with such a device owner the same call becomes a locked task.
   On iOS this is likewise an app-level lock, not OS-enforced Single App Mode.
   Use operator-enabled Guided Access for a supervised session, or separately provision
   supervised-device MDM Single App Mode for enforced kiosk deployments. Neither is
   enabled or controlled by this app.
3. Choose check-in/out, scan a QR or NFC NDEF text `PMB1:<64 lower-case hex>` token,
   take a fresh camera photo, optionally request location, and explicitly confirm the
   displayed worker's name. No gallery/file/import path exists.
   iOS opens a system NFC reader sheet; Android checks whether NFC is enabled first.
   NFC timeout covers both discovery and reading, and backgrounding cancels the scan.
   Session cleanup completes before another scan is allowed; failures are visible.
4. Save durably. A saved/pending event is **not** server confirmation or wage approval.
   Photos are resized to at most 240px wide, JPEG encoded and limited to 36KiB decoded.
   With a portrait/landscape camera input the result is well below 1MP. If location
   permission fails or is skipped, the UI explicitly shows location missing and sends null.
5. Reconnection or the foreground 30-second timer syncs batches of 25; use manual
   sync/retry as needed. Quarantines require office review; native never self-approves.
   Confirmed means durable capture ledger, not payable attendance or wages.

Both shift directions use the same local shift ID. A second check-in and an unmatched
check-out are refused. Open shifts survive restart and may be checked out after renewing
the lease. Use the original device, supervisor and site for check-out. This deliberately
does not guess/adopt open shifts from other devices or supervisors.

Capture requires an owner/company/device-scoped server lease bounded to 72 hours and the
**same boot ID**, measured on a clock that keeps counting while the phone sleeps:

- **Android:** `SystemClock.elapsedRealtime()` and a boot ID derived from
  `Settings.Global.BOOT_COUNT`, from this app's local Expo module
  ([modules/pmb-site](./modules/pmb-site)). React Native's `performance.now()` is
  `CLOCK_MONOTONIC` on Android and stops in deep sleep, which made an honest clock look changed
  after a night's sleep and let a wound-back clock pass (THREAT_MODEL T-37). An app restart
  within the same boot keeps the lease; a reboot needs online renewal. A build without the
  module fails closed. If `BOOT_COUNT` is unavailable, each process gets its own boot ID.
- **iOS:** `performance.now()` (`CLOCK_MONOTONIC_RAW`) already counts sleep, but there is no boot
  identifier, so a new app process always needs online renewal.

Renewal never deletes pending events or open shifts. Moving the wall clock more than two minutes
away from the lease clock fails closed. ADB in developer mode can rewrite `BOOT_COUNT`: managed
devices should disable developer options and USB debugging.
To renew after a restart while locked, re-authenticate to unlock, renew, then re-enter kiosk.

Supervisor controls include basic card issue/revoke and device revocation. Token display
is restricted to unlocked administration for controlled provisioning; this client does
not print QR codes or write NFC tags. Use office provisioning tools to encode cards.
Renew every device roster after card changes; offline devices cannot learn revocations
until online and the API remains authoritative. Permissions and step-up remain server-enforced.

**Revoked registrations are erased** ([D-140](../../docs/ARCHITECTURE.md), THREAT_MODEL T-38).
When registration, lease renewal or sync returns `403 device-revoked`, the app erases that
supervisor/company/device scope in one transaction (roster, open shifts, every event with its
photo and card token) with `secure_delete` and a WAL truncation, deletes its signing key, and
shows how many unsynced captures were lost so the office can re-enter those days through
corrections. Other scopes on the phone are untouched, and no other error code erases anything.
Revoking this phone from its own admin panel is refused while it has unsynced captures; revoke a
lost phone from the office. A phone that never reconnects keeps its encrypted data.

## Storage, sessions and recovery

- SQLCipher is mandatory and checked using `PRAGMA cipher_version`; there is no plaintext
  fallback. The random database key, per-supervisor/company Ed25519 private keys, session
  cookies and persisted kiosk lock live only in `expo-secure-store`. Passwords/MFA codes
  are transient UI input and are cleared after use. No credentials or card tokens are logged.
  All SQL access is serialized on the same keyed connection using `BEGIN IMMEDIATE`:
  Expo's stock exclusive-transaction helper opens a second connection without the key.
- A host-only, path/expiry-aware native `expo/fetch` cookie jar reads each `getSetCookie()`
  header separately (or SDK 55's original `_rawHeaders` tuples when React Native's global
  Headers lacks that method), preserves refresh-cookie paths and rotates/deletes cookies. It
  sends the configured Origin and fresh CSRF token on writes. Redirects fail closed.
  Builds lacking both lossless header interfaces fail rather than splitting combined cookies.
- Each event's UUID, canonical-JSON Ed25519 signature, photo and exact request JSON are
  committed with the shift state in one exclusive database transaction **before sending**.
  Retries reuse identical persisted bytes, even after response loss. Matching server
  receipts and terminal status commit transactionally; events are never delete-on-send.
- Roster replacement and its local checkpoint are atomic full snapshots, not deltas.
  Re-scan if a checkpoint changes between scan and confirmation.
- Pending, failed, conflicted, confirmed and quarantined are distinct. A conflict blocks
  subsequent event sends to preserve in/out ordering. After office/server remediation,
  unlock and explicitly retry conflicts unchanged; never edit a signed event.
- Switching company/account retains all encrypted outboxes and keys, but exposes/sends
  only the currently authenticated supervisor/company/device scope. Uninstalling or
  clearing app data destroys recovery keys. **Never clear data with an unsynced outbox.**
  Storage/key/integrity errors block capture; preserve the installed app and contact support.
  iOS Keychain entries can survive uninstall even though the SQLite outbox does not:
  reinstalling is not recovery and does not restore unsynced events.
  This version deliberately has no plaintext export/re-key/recovery backdoor and never prunes
  queues, except when the server reports the registration revoked (see above).
- Keep device data within the organisation's physical access, retention and managed-device
  policy. Android backup is disabled. A lost key/device needs office-led reconciliation.

## Validation and release limits

`pnpm test` (or repository-root `node --test apps/site/tests/*.test.ts`) runs dependency-free
Node tests against actual in-memory SQLite transactions for queue atomicity, response loss,
ack failures, conflict ordering, scope changes, restart/open shifts, lease bounds and cookies.
These tests do **not** substitute for SQLCipher/Keystore or hardware validation.

After workspace installation and shared-package builds:

```sh
pnpm --filter @pm-buddy/site typecheck
pnpm --filter @pm-buddy/site test
pnpm --filter @pm-buddy/site build
```

`build` exports **both Android and iOS** bundles (no web target); `build:android` and
`build:ios` export one platform. These are **not APK/AAB/IPA builds or native SQLCipher tests**.
Use properly signed native release builds for distribution. EAS credentials,
store submission and managed-device MDM are not configured here. Android/iOS bundle
exports and TypeScript can be checked locally, but native iOS compilation and real-device
acceptance on both platforms remain release gates. Automatic sync
is foreground/reconnect-based, not a guaranteed killed-app/background-OS task.
The main controls have concise EN/SW labels; technical/recovery explanations remain English.

### Local Android debug build and emulator check

With JDK 17 (`JAVA_HOME`) and the Android SDK (`ANDROID_HOME`; platform 36, build-tools
36.0.0, NDK 27.1.12297006), from this directory:

```sh
CI=1 pnpm exec expo prebuild --platform android --no-install
(cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081 && adb reverse tcp:4000 tcp:4000   # Metro and the API
pnpm dev
```

On 16/11/2026 this built (first build about 19 minutes) and ran on an Android 15 arm64
emulator against a scratch database. Verified there: an encrypted database file (no plaintext
SQLite header), sign-in, company selection, registration and the lease anchored on the
`BOOT_COUNT` boot ID and `elapsedRealtime`, screen pinning and its release after password
re-authentication, kiosk and lease surviving an app restart, refusal after a reboot until
renewal, QR decoding by the emulator's virtual-scene camera, fresh photo, signed
capture accepted by the server with its receipt returned, an offline pending check-out, and
the erase after an office revocation (1 unsynced, 1 synced reported). Not covered: NFC, real
camera optics, GPS (the emulator gave no fix), real deep sleep, iOS and signed release builds.

### Real-device acceptance checklist

- Install a clean development build; verify SQLCipher availability and fail-closed behavior
  in an unsupported build. Verify encrypted database contents cannot be opened as plaintext.
- Sign in/MFA/select company, renew, QR and NFC scan known workers; deny camera and GPS,
  disable/remove NFC, cancel NFC, scan unknown/revoked cards, and check clear visible errors.
- Take both portrait/landscape photos; verify fresh worker image, <=36KiB JPEG, matching
  SHA-256/signature and no photo left in the app camera cache after processing.
- Capture offline in/out, force-stop/restart, verify lock/outbox/open shift persist. On Android
  capture must continue in the same boot without renewal; after a reboot (and on iOS after any
  restart) it must fail until re-authentication/lease renewal, then old-shift out must still pair.
- Leave the phone asleep (screen off, app in the background) for several hours, then capture
  offline: the lease must stay valid with an honest clock, and a wall clock wound back by an hour
  must be refused.
- Change device time; exceed 72h; verify refusal. Confirm two ins and unmatched outs fail.
- Reconnect with queued events; interrupt network after server commit; retry and verify
  one immutable receipt, no double allocation, terminal flags visible and no event loss.
- Inject storage-full/ack-write errors; restart and recover the same event bytes.
- Switch user/company, including during failed requests, and verify no cross-scope
  sends or queue display. Kill during lease install/capture/receipt commit and retry.
- In kiosk test Android back, app restart, supervisor wrong password and MFA failures;
  cards/site/signout must remain inaccessible until the original supervisor re-authenticates.
  Accept and decline the screen-pinning prompt, use the unpin gesture, and check re-pinning on
  return and unpinning after re-authentication. With a test device-owner app that allow-lists
  the package, verify the locked task cannot be left.
- Revoke the registration from the office with queued captures; on the next sync or renewal
  verify the erase notice and counts, that other supervisors' outboxes are intact, and that
  capture needs a new registration.
- Repeat the offline, restart, encryption, key isolation, sync-loss and kiosk cases on
  iPhone and iPad. Check iOS safe areas, password/MFA keyboard access, system NFC
  cancellation, no-NFC QR fallback, camera/location denial and app background/foreground.
  Verify Guided Access/MDM separately if the deployment requires OS-level confinement.
- Confirm office review by a different stepped-up person is required for quarantines;
  receipt confirmation alone must not create wages.
