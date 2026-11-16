# PM-Buddy: Offline sync contract

Phase 3 contract. The native attendance slice below implements a bounded subset; the office web app does not cache sensitive business data or claim offline operation.

## Implemented attendance capture slice (D3.2/D3.3)

The Expo client lives in [apps/site](../apps/site/README.md); the wire schemas are
[site-attendance.ts](../packages/validation/src/site-attendance.ts).

- Authentication reuses the existing password/MFA/company session and CSRF controls through a
  secure-store native cookie jar. User/company/device identities scope local keys, roster and
  outbox. Sync always rechecks current authorisation and revocation before acknowledging replay.
- The server registers an Ed25519 public key and issues an immutable, 72-hour lease with server
  time, a boot ID and a boot-clock sample, plus a minimal full authorised roster. Installing
  that snapshot and checkpoint is one local SQLCipher transaction. This is snapshot pull, not a
  general incremental change-log/cursor engine for other modules.
- Each direction of a shift is a schema-v1 UUID event with the same shift UUID, QR/NFC token,
  photo SHA-256, claimed position/time, monotonic evidence and explicit supervisor confirmation.
  The signature covers UTF-8 canonical JSON (recursively sorted object keys, unchanged arrays).
  An encrypted local transaction persists the signed request and open-shift state before sending.
- Push sends one event at a time to `POST /api/v1/attendance/capture/events`, preserving order and
  exact signed bytes. One small JPEG (maximum 36 KiB, one megapixel) is included in the same JSON
  request, so there is no falsely complete event awaiting an attachment upload. Server photos
  are encrypted with the authentication encryption key under the `attendance-camera` purpose,
  accessed only through an audited, project-authorised, no-store JPEG route. Key rotation must
  preserve/re-encrypt this evidence; retention/deletion jobs are not implemented.
- `confirmed` acknowledges durable evidence only. `quarantined` also retains evidence and flags,
  but requires office review. Event-ID reuse with different content conflicts; the same signed
  event returns its original immutable receipt, even when later review changes its allocation.
  The review queue exposes the current `recordId` separately. The client never deletes on send.
- Drift compares claimed time to server anchor + monotonic elapsed time; delayed reconnection is
  not drift. More than two minutes, boot changes/backwards counters, captures outside the lease,
  unknown/outside historical geofences, duplicates, revoked cards and implausible inter-site
  travel are review signals. Implemented thresholds: GPS accuracy at most 50 m, 30 m fence allowance,
  duplicate window below two minutes, travel above 200 km/h after accuracy allowance and 1 km.
- Eligible paired scans create one draft muster record. The original recorder remains the maker;
  submission/confirmation and payroll approval keep their existing independent checks. Flags do
  not automatically deny wages: a different stepped-up person resolves/dismisses them. Existing
  entries and locked days/periods require ordinary corrections/adjustments, never last-write-wins.
  Unallocated undecided evidence blocks period submission/approval.

Native builds are mandatory (not Expo Go or web). The lease clock must keep counting while the
phone sleeps: Android uses `SystemClock.elapsedRealtime()` and a boot ID derived from
`Settings.Global.BOOT_COUNT` (the app's local Expo module; a build without it fails closed), so
an app restart within one boot keeps the lease and a reboot needs online renewal. iOS uses
`performance.now()` (`CLOCK_MONOTONIC_RAW`, which counts sleep) with a per-process ID, so a new
iOS process needs renewal. Queued events and open shifts always survive. ADB in developer mode
can rewrite `BOOT_COUNT`; managed devices should disable developer options and USB debugging.
On Android the supervisor lock also requests screen pinning; without a device owner that
allow-lists the app, the system unpin gesture still works and the app re-requests pinning when
it returns to the foreground. Sync is foreground/reconnect-based, not a guaranteed
killed-process service.

A registration that the server reports as revoked (`403 device-revoked` from registration,
lease renewal or push) is erased at that contact: roster, open shifts, every event with its photo
and card token, and its signing key (`secure_delete`, WAL truncation). The app shows how many
unsynced captures were lost; the office re-enters those days through corrections. A lost phone
that never reconnects keeps its encrypted data. A user whose access is withdrawn is refused, but
their encrypted scope stays on the phone until they sign in again. Retention jobs, general
multi-module sync, resumable large uploads, physical-device field evidence and signed app
distribution remain outstanding.

The initial [Android/iOS site app](../apps/site/README.md) implements an
attendance-specific encrypted outbox, device-key binding, bounded lease, full roster
snapshot pull and receipt-based event push. This is not yet a general offline engine:
offline goods received notes, site-diary photo uploads, attachment resumption and
incremental change cursors remain pending. The kiosk is a supervisor application lock plus
Android screen pinning, not device-owner lock task (unless an MDM allow-lists the app) or
supervised iOS Single App Mode. Native-device
acceptance is required separately on both platforms; JS bundle export is not that evidence.

## Envelope and identity

Each event carries a stable client-generated UUID, registered device ID, schema version, tenant/project identity hints, entity ID, expected entity version when editable, claimed capture time, monotonic/device-clock evidence and payload fingerprint. The server derives authorised tenant/project access; submitted IDs are never authority.

Transport is at least once. A unique tenant/device/event ID and payload digest make retries return the original durable result. Same ID with different content conflicts. A transaction writes the event, applicable domain effect, audit and outbox before acknowledging.

## Push, pull and checkpoints

1. Authenticate device/user and check active membership, device revocation, lease and schema compatibility.
2. Validate each item, returning `confirmed`, `conflicted`, `failed` or `quarantined` plus a durable server receipt/version and actionable reason.
3. Keep local events until confirmed durable acknowledgement; never delete on send or mere HTTP success. Partial batch failure cannot skip unacknowledged items.
4. Pull only currently authorised changes with an opaque monotonic cursor. Advance the local checkpoint only after the local transaction durably applies the page.
5. Show pending, syncing, confirmed, conflicted and failed states, last durable sync and missing attachments. Recover after process termination and storage exhaustion without silently dropping evidence.

## Conflicts and immutable records

Attendance and stock are append-only movement events. Corrections reference original IDs with reason, actor and fresh approval where required. Financial events and approved records are never last-write-wins.

Editable drafts require expected-version checks. Consequential concurrent changes go to a review queue; preserve both submitted evidence and server version. Late attendance for a closed payroll period creates a correction case, not recalculation of paid payroll.

## Revocation and shared devices

Server checks authorisation at sync time, not capture time. Revoked users/devices receive no new sensitive data. For attendance capture a revoked device erases its local scope at the next authenticated contact and unsynced evidence is re-entered through corrections; there is no write-only recovery intake ([D-140](./ARCHITECTURE.md)).

Offline access uses a bounded configurable lease, encrypted local storage and platform secure credential storage. On lease expiry require re-authentication before sensitive viewing/capture. A disconnected device cannot be wiped immediately: document exposure, eventual wipe, kiosk session boundaries and lost-device response. No biometric rollout before privacy review.

## Attachments and provenance

Upload attachments independently with resumable chunks, checksums, tenant/project-scoped private object keys, bounded signed URLs and size/type/malware controls. A confirmed event may have incomplete evidence; show this explicitly and prevent evidence-dependent approval until complete.

Store claimed capture GPS/time separately from server receipt time and verification confidence. Device key signatures attest key possession, not physical presence or an honest clock. Drift/geofence/fraud signals require human review, never automatic wage denial.

## Compatibility and recovery

Version envelopes and API contracts. Publish minimum supported app/schema versions. Use expand-contract database/API changes, transactional local migrations and recoverable upgrade flows that export/preserve unsynced records. Test a device reconnecting after weeks offline; unsupported versions get explicit instructions, never silent drops.

RPO covers acknowledged server data only; unsynced device records remain exposed to device loss. Attachment retention/versioning must support the same restore point as database references. Restore requires missing-object checks, payment pause and reconciliation, not blind outbox replay.

Required field evidence: low-end Android, several offline days, duplicate batches, clock change, storage full, termination during local commit, interrupted uploads, revoked device, late payroll evidence and old-client upgrade. Record manual evidence separately from automated tests.
