# PM-Buddy: Offline sync contract

Design for Phase 3; no claim that the current web prototype works offline.

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

Server checks authorisation at sync time, not capture time. Revoked users/devices receive no new sensitive data; already captured evidence can enter a separately authorised, write-only quarantine intake under an approved policy, never normal domain processing by default.

Offline access uses a bounded configurable lease, encrypted local storage and platform secure credential storage. On lease expiry require re-authentication before sensitive viewing/capture. A disconnected device cannot be wiped immediately: document exposure, eventual wipe, kiosk session boundaries and lost-device response. No biometric rollout before privacy review.

## Attachments and provenance

Upload attachments independently with resumable chunks, checksums, tenant/project-scoped private object keys, bounded signed URLs and size/type/malware controls. A confirmed event may have incomplete evidence; show this explicitly and prevent evidence-dependent approval until complete.

Store claimed capture GPS/time separately from server receipt time and verification confidence. Device key signatures attest key possession, not physical presence or an honest clock. Drift/geofence/fraud signals require human review, never automatic wage denial.

## Compatibility and recovery

Version envelopes and API contracts. Publish minimum supported app/schema versions. Use expand-contract database/API changes, transactional local migrations and recoverable upgrade flows that export/preserve unsynced records. Test a device reconnecting after weeks offline; unsupported versions get explicit instructions, never silent drops.

RPO covers acknowledged server data only; unsynced device records remain exposed to device loss. Attachment retention/versioning must support the same restore point as database references. Restore requires missing-object checks, payment pause and reconciliation, not blind outbox replay.

Required field evidence: low-end Android, several offline days, duplicate batches, clock change, storage full, termination during local commit, interrupted uploads, revoked device, late payroll evidence and old-client upgrade. Record manual evidence separately from automated tests.
