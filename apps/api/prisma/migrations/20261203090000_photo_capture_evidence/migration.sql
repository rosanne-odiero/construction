-- D6.1 photo evidence to the THREAT_MODEL A-13 target, as far as a browser allows:
-- * photo_capture_tickets: the server records when a user opened PM-Buddy's camera screen for a
--   site. An in-app photo carries one ticket (single use), so its capture time is bounded by the
--   server clock; the browser's position comes with its accuracy radius.
-- * Only in-app photos can be verified. Imported files (gallery, desktop, HEIC) keep their EXIF
--   checks for review but are never verified.
-- * perceptual_hash: a 64-bit difference hash of every new photo. A photo that looks like an
--   earlier one of the company from another day or another project is not verified, and records
--   which one (similar_photo_id) and how close (similarity_distance).
-- * HEIC originals are kept as uploaded (content_type, `original.heic`); thumbnails stay JPEG.
--
-- Photos recorded before this migration were all file uploads checked on their EXIF only. They
-- are reclassified as imported, not similarity-checked, and therefore no longer verified: the
-- stricter rule applies to every badge (pre-production data; the evidence columns are unchanged).
BEGIN;

CREATE TABLE "photo_capture_tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "issued_to" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_capture_tickets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "photo_capture_tickets_tenant_id_project_id_site_id_id_key"
  ON "photo_capture_tickets"("tenant_id", "project_id", "site_id", "id");
ALTER TABLE "photo_capture_tickets" ADD CONSTRAINT "photo_capture_tickets_site_fkey"
  FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- The ticket's owner and time are the server's: the authenticated user, now().
CREATE FUNCTION app.guard_photo_capture_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.issued_to IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A capture ticket is issued to the authenticated user' USING ERRCODE = '23514';
  END IF;
  NEW.issued_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER photo_capture_ticket_guard BEFORE INSERT ON "photo_capture_tickets"
  FOR EACH ROW EXECUTE FUNCTION app.guard_photo_capture_ticket();
CREATE TRIGGER photo_capture_ticket_append_only BEFORE UPDATE OR DELETE ON "photo_capture_tickets"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

ALTER TABLE "photo_capture_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "photo_capture_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY photo_capture_tickets_read ON photo_capture_tickets FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY photo_capture_tickets_insert ON photo_capture_tickets FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND issued_to = app.current_user_id());

ALTER TABLE "site_photos"
  ADD COLUMN "content_type" VARCHAR(20) NOT NULL DEFAULT 'image/jpeg',
  ADD COLUMN "capture_method" VARCHAR(10) NOT NULL DEFAULT 'imported',
  ADD COLUMN "capture_ticket_id" UUID,
  ADD COLUMN "location_accuracy_m" DECIMAL(8,1),
  ADD COLUMN "perceptual_hash" BIGINT,
  ADD COLUMN "similarity_check" VARCHAR(12) NOT NULL DEFAULT 'not_checked',
  ADD COLUMN "similar_photo_id" UUID,
  ADD COLUMN "similar_project_id" UUID,
  ADD COLUMN "similarity_distance" SMALLINT;
ALTER TABLE "site_photos"
  ALTER COLUMN "content_type" DROP DEFAULT,
  ALTER COLUMN "capture_method" DROP DEFAULT,
  ALTER COLUMN "similarity_check" DROP DEFAULT;

-- The old rule (verified = inside and on time) goes first, then the reclassification.
ALTER TABLE "site_photos" DROP CONSTRAINT "site_photos_checks_check";
-- Forced row-level security binds the owner too: lift it (and the append-only trigger) for the
-- reclassification only.
ALTER TABLE "site_photos" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "site_photos" DISABLE TRIGGER site_photo_append_only;
UPDATE "site_photos" SET verified = false WHERE verified;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM site_photos WHERE verified) THEN
    RAISE EXCEPTION 'Earlier photos were not reclassified';
  END IF;
END
$$;
ALTER TABLE "site_photos" ENABLE TRIGGER site_photo_append_only;
ALTER TABLE "site_photos" FORCE ROW LEVEL SECURITY;

-- A ticket is used once, by a photo of the same tenant, project and site.
CREATE UNIQUE INDEX "site_photos_capture_ticket_id_key" ON "site_photos"("capture_ticket_id");
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_capture_ticket_fkey"
  FOREIGN KEY ("tenant_id", "project_id", "site_id", "capture_ticket_id")
  REFERENCES "photo_capture_tickets"("tenant_id", "project_id", "site_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_similar_photo_fkey"
  FOREIGN KEY ("tenant_id", "similar_project_id", "similar_photo_id")
  REFERENCES "site_photos"("tenant_id", "project_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "site_photos" DROP CONSTRAINT "site_photos_keys_check";
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_keys_check" CHECK (
  content_type IN ('image/jpeg', 'image/heic')
  AND object_key = 'tenants/' || tenant_id || '/projects/' || project_id || '/photos/' || id
    || '/original.' || CASE content_type WHEN 'image/heic' THEN 'heic' ELSE 'jpg' END
  AND thumbnail_key = 'tenants/' || tenant_id || '/projects/' || project_id || '/photos/' || id || '/thumbnail.jpg'
);

-- packages/domain PHOTO_CAPTURE_METHODS, PHOTO_LOCATION_CHECKS, PHOTO_TIME_CHECKS,
-- PHOTO_TIME_SOURCES, PHOTO_SIMILARITY_CHECKS and isVerifiedPhoto
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_checks_check" CHECK (
  capture_method IN ('in_app', 'imported')
  AND location_check IN ('inside', 'outside', 'missing', 'no_geofence', 'low_accuracy')
  AND time_check IN ('ok', 'future', 'stale', 'missing', 'diary_mismatch', 'outside_window')
  AND (time_source IS NULL OR time_source IN ('gps', 'offset', 'assumed_nairobi', 'device'))
  AND similarity_check IN ('unique', 'similar', 'not_checked')
  AND verified = (capture_method = 'in_app' AND location_check = 'inside' AND time_check = 'ok'
    AND similarity_check = 'unique')
  -- In-app: a ticket, the phone's clock and the browser's accuracy; imported: EXIF only.
  AND (capture_method = 'in_app') = (capture_ticket_id IS NOT NULL)
  AND (COALESCE(time_source, '') = 'device') = (capture_method = 'in_app' AND captured_at IS NOT NULL)
  AND (location_accuracy_m IS NOT NULL) = (capture_method = 'in_app' AND latitude IS NOT NULL)
  AND (location_accuracy_m IS NULL OR location_accuracy_m >= 0)
  AND (location_check <> 'low_accuracy' OR capture_method = 'in_app')
  AND (time_check <> 'outside_window' OR capture_method = 'in_app')
  AND (latitude IS NULL) = (longitude IS NULL)
  AND (location_check = 'missing') = (latitude IS NULL)
  AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))
  AND (distance_m IS NOT NULL) = (location_check = 'outside')
  AND (distance_m IS NULL OR distance_m >= 0)
  AND (captured_at IS NULL) = (time_source IS NULL)
  AND (captured_at IS NULL) = (time_check = 'missing')
  AND (geofence_version IS NULL) = (location_check IN ('missing', 'no_geofence', 'low_accuracy'))
  AND (perceptual_hash IS NULL) = (similarity_check = 'not_checked')
  AND (similar_photo_id IS NOT NULL) = (similarity_check = 'similar')
  AND (similar_photo_id IS NULL) = (similar_project_id IS NULL)
  AND (similar_photo_id IS NULL) = (similarity_distance IS NULL)
  AND (similarity_distance IS NULL OR similarity_distance BETWEEN 0 AND 64)
  AND similar_photo_id IS DISTINCT FROM id
);

CREATE OR REPLACE FUNCTION app.guard_site_photo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
  diary_status text;
  ticket_owner uuid;
BEGIN
  IF NEW.uploaded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A photo is recorded by the authenticated uploader' USING ERRCODE = '23514';
  END IF;
  IF NEW.similarity_check = 'not_checked' THEN
    RAISE EXCEPTION 'A new photo is checked against earlier photos' USING ERRCODE = '23514';
  END IF;
  IF NEW.capture_ticket_id IS NOT NULL THEN
    SELECT issued_to INTO ticket_owner FROM photo_capture_tickets
      WHERE tenant_id = NEW.tenant_id AND id = NEW.capture_ticket_id;
    IF ticket_owner IS DISTINCT FROM NEW.uploaded_by THEN
      RAISE EXCEPTION 'A capture ticket is used by whoever opened the camera' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT status INTO project_status FROM projects
    WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR SHARE;
  IF project_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
  IF NEW.diary_id IS NOT NULL THEN
    SELECT status INTO diary_status FROM site_diaries
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.diary_id FOR SHARE;
    IF diary_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Photos can be attached only to a draft diary' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "photo_capture_tickets" FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_photo_capture_ticket() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_site_photo() FROM PUBLIC;

COMMIT;
