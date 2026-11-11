-- D6.1 geotagged site photos. Each row is append-only evidence: the API reads the photo's own EXIF
-- position and capture time and records the result of checking them against the site geofence
-- version in force at capture (packages/domain verifyPhotoEvidence). The database backstops the
-- shape of that record, the private object keys, tenant/project/site/diary consistency, that a
-- photo is attached only to a draft diary (an approved diary stays locked), and immutability.
BEGIN;

CREATE UNIQUE INDEX "site_diaries_tenant_id_site_id_id_key" ON "site_diaries"("tenant_id", "site_id", "id");

CREATE TABLE "site_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "diary_id" UUID,
    "caption" VARCHAR(500),
    "object_key" VARCHAR(300) NOT NULL,
    "thumbnail_key" VARCHAR(300) NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "scan_status" VARCHAR(20) NOT NULL,
    "scan_engine" VARCHAR(60) NOT NULL,
    "scanned_at" TIMESTAMPTZ NOT NULL,
    "captured_at" TIMESTAMPTZ,
    "time_source" VARCHAR(20),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "camera" VARCHAR(120),
    "geofence_version" INTEGER,
    "location_check" VARCHAR(12) NOT NULL,
    "time_check" VARCHAR(16) NOT NULL,
    "distance_m" DECIMAL(10,1),
    "verified" BOOLEAN NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_photos_tenant_id_project_id_file_sha256_key"
  ON "site_photos"("tenant_id", "project_id", "file_sha256");
CREATE INDEX "site_photos_tenant_id_project_id_id_idx" ON "site_photos"("tenant_id", "project_id", "id");
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_site_fkey"
  FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_diary_fkey"
  FOREIGN KEY ("tenant_id", "site_id", "diary_id") REFERENCES "site_diaries"("tenant_id", "site_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_keys_check" CHECK (
  object_key = 'tenants/' || tenant_id || '/projects/' || project_id || '/photos/' || id || '/original.jpg'
  AND thumbnail_key = 'tenants/' || tenant_id || '/projects/' || project_id || '/photos/' || id || '/thumbnail.jpg'
);
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_file_check" CHECK (
  file_sha256 ~ '^[a-f0-9]{64}$' AND size_bytes BETWEEN 1 AND 15728640
  AND width > 0 AND height > 0 AND width::bigint * height <= 50000000
);
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_scan_check" CHECK (
  scan_status IN ('clean', 'not_scanned')
);
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_caption_check" CHECK (
  caption IS NULL OR char_length(btrim(caption)) >= 1
);
-- packages/domain PHOTO_LOCATION_CHECKS, PHOTO_TIME_CHECKS, PHOTO_TIME_SOURCES
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_checks_check" CHECK (
  location_check IN ('inside', 'outside', 'missing', 'no_geofence')
  AND time_check IN ('ok', 'future', 'stale', 'missing', 'diary_mismatch')
  AND (time_source IS NULL OR time_source IN ('gps', 'offset', 'assumed_nairobi'))
  AND verified = (location_check = 'inside' AND time_check = 'ok')
  AND (latitude IS NULL) = (longitude IS NULL)
  AND (location_check = 'missing') = (latitude IS NULL)
  AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))
  AND (distance_m IS NOT NULL) = (location_check = 'outside')
  AND (distance_m IS NULL OR distance_m >= 0)
  AND (captured_at IS NULL) = (time_source IS NULL)
  AND (captured_at IS NULL) = (time_check = 'missing')
  AND (geofence_version IS NULL) = (location_check IN ('missing', 'no_geofence'))
);

CREATE FUNCTION app.guard_site_photo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
  diary_status text;
BEGIN
  IF NEW.uploaded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A photo is recorded by the authenticated uploader' USING ERRCODE = '23514';
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
CREATE TRIGGER site_photo_guard BEFORE INSERT ON "site_photos"
  FOR EACH ROW EXECUTE FUNCTION app.guard_site_photo();
CREATE TRIGGER site_photo_append_only BEFORE UPDATE OR DELETE ON "site_photos"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

ALTER TABLE "site_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY site_photos_read ON site_photos FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY site_photos_insert ON site_photos FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND uploaded_by = app.current_user_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "site_photos" FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_site_photo() FROM PUBLIC;

COMMIT;
