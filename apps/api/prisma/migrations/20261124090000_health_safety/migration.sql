-- D8.2 Health and safety (brief §5.12 "site induction records, toolbox talks with attendance, PPE
-- register, incident and near-miss reporting with photos, first-aid log, corrective actions" and
-- §15 C/F; ARCHITECTURE §4.9; ERD §9; WORKFLOWS "Health and safety").
-- Enforces, in the database as well as the API:
-- * safety_settings: the company's induction checklist, induction validity and attendance
--   look-back, the first-aid kit check interval and PPE replacement periods.
-- * safety_inductions: a labourer (engaged on the project), staff member or named visitor inducted
--   at a site; fixed once recorded, voided with a reason (never edited or deleted).
-- * toolbox_talks + toolbox_talk_attendees: draft while attendance is taken → confirmed (LOCKED,
--   at least one attendee) or cancelled with a reason; attendees change only while it is a draft.
-- * ppe_issues: a register (no stock movement; decision D-72): issued → returned (condition),
--   replaced (only by a newer issue naming it) or voided; the replacement date is issue date +
--   the period used, fixed at issue.
-- * safety_incidents + safety_incident_people + safety_incident_photos: reported → investigated
--   (root cause) → closed, or voided with a reason. Closing needs every corrective action verified
--   or cancelled, a verified action or a reason for none, and a recorded regulator decision for
--   serious and fatal injuries and dangerous occurrences (COMPLIANCE-REVIEW CR-HS-01). A CLOSED
--   (or voided) INCIDENT IS LOCKED: its row, people, photos, corrective actions and linked
--   treatments can no longer change, for any role.
-- * corrective_actions: open → done (only by the owner) → verified (only by someone who is
--   neither the owner nor whoever marked it done); done → open (rejected with a reason) by such a
--   verifier; open or done → cancelled with a reason; verified and cancelled are final.
-- * first_aid_kits + first_aid_kit_checks (append-only), first_aiders, first_aid_treatments
--   (voided with a reason; linked to an open incident at most once).
-- * Every record is numbered in order per project where it has a number; closed and cancelled
--   projects are read-only. Guards never skip their checks because they run inside another trigger:
--   only a cascade from a parent row that is already gone is let through (D6.1 review finding 2).
-- Every table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys.
-- No new permissions (safety.manage, site.diary and projects.manage already exist), so the
-- permission CHECK constraints are unchanged.
BEGIN;

-- CreateTable
CREATE TABLE "safety_settings" (
    "tenant_id" UUID NOT NULL,
    "induction_topics" JSONB NOT NULL,
    "induction_validity_days" INTEGER,
    "induction_lookback_days" INTEGER NOT NULL DEFAULT 14,
    "kit_check_interval_days" INTEGER NOT NULL DEFAULT 30,
    "ppe_replacement_days" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "safety_inductions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "person_kind" VARCHAR(10) NOT NULL,
    "labourer_id" UUID,
    "user_id" UUID,
    "visitor_name" VARCHAR(120),
    "visitor_organisation" VARCHAR(120),
    "inducted_on" DATE NOT NULL,
    "inductor_id" UUID NOT NULL,
    "topics" JSONB NOT NULL,
    "topics_total" INTEGER NOT NULL,
    "acknowledgement" VARCHAR(12) NOT NULL,
    "notes" VARCHAR(500),
    "status" VARCHAR(10) NOT NULL DEFAULT 'recorded',
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ,
    "void_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "safety_inductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "toolbox_talks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "held_on" DATE NOT NULL,
    "topic" VARCHAR(200) NOT NULL,
    "notes" VARCHAR(2000),
    "duration_minutes" INTEGER,
    "presenter_id" UUID NOT NULL,
    "photo_id" UUID,
    "other_attendees" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(10) NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "toolbox_talks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "toolbox_talk_attendees" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "talk_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "via_gang_id" UUID,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "toolbox_talk_attendees_pkey" PRIMARY KEY ("tenant_id","talk_id","labourer_id")
);

-- CreateTable
CREATE TABLE "ppe_issues" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "item" VARCHAR(20) NOT NULL,
    "size" VARCHAR(12),
    "quantity" INTEGER NOT NULL,
    "issued_on" DATE NOT NULL,
    "replacement_days" INTEGER NOT NULL,
    "replacement_due_on" DATE NOT NULL,
    "replaces_issue_id" UUID,
    "status" VARCHAR(10) NOT NULL DEFAULT 'issued',
    "returned_on" DATE,
    "return_condition" VARCHAR(8),
    "returned_by" UUID,
    "returned_at" TIMESTAMPTZ,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ,
    "void_reason" VARCHAR(500),
    "issued_by" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ppe_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_incidents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "severity" VARCHAR(10) NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "location" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "immediate_actions" VARCHAR(2000),
    "first_aid_given" BOOLEAN NOT NULL,
    "status" VARCHAR(14) NOT NULL DEFAULT 'reported',
    "reported_by" UUID NOT NULL,
    "reported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "root_cause_category" VARCHAR(24),
    "root_cause" VARCHAR(2000),
    "contributing_factors" VARCHAR(2000),
    "investigated_by" UUID,
    "investigated_at" TIMESTAMPTZ,
    "regulator_decision" VARCHAR(16),
    "regulator_notified_on" DATE,
    "regulator_reference" VARCHAR(60),
    "regulator_reason" VARCHAR(500),
    "regulator_decided_by" UUID,
    "regulator_decided_at" TIMESTAMPTZ,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ,
    "closure_note" VARCHAR(1000),
    "no_action_reason" VARCHAR(500),
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ,
    "void_reason" VARCHAR(500),
    "follow_up_of_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_incident_people" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "role" VARCHAR(8) NOT NULL,
    "labourer_id" UUID,
    "user_id" UUID,
    "name" VARCHAR(120),
    "injury_type" VARCHAR(16),
    "body_part" VARCHAR(10),
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_incident_people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_incident_photos" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_incident_photos_pkey" PRIMARY KEY ("tenant_id","incident_id","photo_id")
);

-- CreateTable
CREATE TABLE "corrective_actions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "source" VARCHAR(14) NOT NULL,
    "incident_id" UUID,
    "inspection_id" UUID,
    "toolbox_talk_id" UUID,
    "description" VARCHAR(1000) NOT NULL,
    "owner_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'open',
    "done_by" UUID,
    "done_at" TIMESTAMPTZ,
    "done_note" VARCHAR(1000),
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ,
    "reject_count" INTEGER NOT NULL DEFAULT 0,
    "last_reject_reason" VARCHAR(500),
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),
    "raised_by" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corrective_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "first_aid_kits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "location" VARCHAR(200),
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "retired_by" UUID,
    "retired_at" TIMESTAMPTZ,
    "retired_reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "first_aid_kits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "first_aid_kit_checks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kit_id" UUID NOT NULL,
    "checked_on" DATE NOT NULL,
    "outcome" VARCHAR(10) NOT NULL,
    "expires_on" DATE,
    "notes" VARCHAR(500),
    "checked_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "first_aid_kit_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "first_aiders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "labourer_id" UUID,
    "user_id" UUID,
    "certificate_expires_on" DATE NOT NULL,
    "certificate_reference" VARCHAR(60),
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "removed_by" UUID,
    "removed_at" TIMESTAMPTZ,
    "removed_reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "first_aiders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "first_aid_treatments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "treated_at" TIMESTAMPTZ NOT NULL,
    "labourer_id" UUID,
    "person_name" VARCHAR(120),
    "injury_type" VARCHAR(16) NOT NULL,
    "treatment" VARCHAR(20) NOT NULL,
    "referral" VARCHAR(10) NOT NULL,
    "first_aider_id" UUID,
    "incident_id" UUID,
    "status" VARCHAR(10) NOT NULL DEFAULT 'recorded',
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ,
    "void_reason" VARCHAR(500),
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "first_aid_treatments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "safety_inductions_tenant_id_site_id_labourer_id_idx" ON "safety_inductions"("tenant_id", "site_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "safety_inductions_tenant_id_id_key" ON "safety_inductions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "safety_inductions_tenant_id_project_id_id_key" ON "safety_inductions"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "safety_inductions_tenant_id_project_id_number_key" ON "safety_inductions"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE INDEX "toolbox_talks_tenant_id_project_id_status_idx" ON "toolbox_talks"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "toolbox_talks_tenant_id_id_key" ON "toolbox_talks"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "toolbox_talks_tenant_id_project_id_id_key" ON "toolbox_talks"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "toolbox_talks_tenant_id_project_id_number_key" ON "toolbox_talks"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE INDEX "toolbox_talk_attendees_tenant_id_labourer_id_idx" ON "toolbox_talk_attendees"("tenant_id", "labourer_id");

-- CreateIndex
CREATE INDEX "ppe_issues_tenant_id_project_id_status_replacement_due_on_idx" ON "ppe_issues"("tenant_id", "project_id", "status", "replacement_due_on");

-- CreateIndex
CREATE INDEX "ppe_issues_tenant_id_labourer_id_idx" ON "ppe_issues"("tenant_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "ppe_issues_tenant_id_id_key" ON "ppe_issues"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ppe_issues_tenant_id_project_id_id_key" ON "ppe_issues"("tenant_id", "project_id", "id");

-- CreateIndex
-- One live replacement per item; a voided replacement frees the item to be replaced again.
CREATE UNIQUE INDEX "ppe_issues_tenant_id_replaces_issue_id_key" ON "ppe_issues"("tenant_id", "replaces_issue_id")
  WHERE status <> 'voided';

-- CreateIndex
CREATE INDEX "safety_incidents_tenant_id_project_id_status_idx" ON "safety_incidents"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "safety_incidents_tenant_id_id_key" ON "safety_incidents"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "safety_incidents_tenant_id_project_id_id_key" ON "safety_incidents"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "safety_incidents_tenant_id_project_id_number_key" ON "safety_incidents"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE INDEX "safety_incident_people_tenant_id_incident_id_idx" ON "safety_incident_people"("tenant_id", "incident_id");

-- CreateIndex
CREATE INDEX "safety_incident_people_tenant_id_labourer_id_idx" ON "safety_incident_people"("tenant_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "safety_incident_people_tenant_id_id_key" ON "safety_incident_people"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "safety_incident_photos_tenant_id_project_id_photo_id_idx" ON "safety_incident_photos"("tenant_id", "project_id", "photo_id");

-- CreateIndex
CREATE INDEX "corrective_actions_tenant_id_project_id_status_due_on_idx" ON "corrective_actions"("tenant_id", "project_id", "status", "due_on");

-- CreateIndex
CREATE INDEX "corrective_actions_tenant_id_incident_id_idx" ON "corrective_actions"("tenant_id", "incident_id");

-- CreateIndex
CREATE INDEX "corrective_actions_tenant_id_owner_id_idx" ON "corrective_actions"("tenant_id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "corrective_actions_tenant_id_id_key" ON "corrective_actions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "corrective_actions_tenant_id_project_id_id_key" ON "corrective_actions"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "corrective_actions_tenant_id_project_id_number_key" ON "corrective_actions"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "first_aid_kits_tenant_id_id_key" ON "first_aid_kits"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "first_aid_kits_tenant_id_project_id_id_key" ON "first_aid_kits"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "first_aid_kits_tenant_id_site_id_label_key" ON "first_aid_kits"("tenant_id", "site_id", "label");

-- CreateIndex
CREATE INDEX "first_aid_kit_checks_tenant_id_kit_id_checked_on_idx" ON "first_aid_kit_checks"("tenant_id", "kit_id", "checked_on");

-- CreateIndex
CREATE UNIQUE INDEX "first_aid_kit_checks_tenant_id_id_key" ON "first_aid_kit_checks"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "first_aiders_tenant_id_id_key" ON "first_aiders"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "first_aiders_tenant_id_project_id_id_key" ON "first_aiders"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE INDEX "first_aid_treatments_tenant_id_project_id_treated_at_idx" ON "first_aid_treatments"("tenant_id", "project_id", "treated_at");

-- CreateIndex
CREATE UNIQUE INDEX "first_aid_treatments_tenant_id_id_key" ON "first_aid_treatments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "first_aid_treatments_tenant_id_project_id_id_key" ON "first_aid_treatments"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "first_aid_treatments_tenant_id_project_id_number_key" ON "first_aid_treatments"("tenant_id", "project_id", "number");

-- AddForeignKey
ALTER TABLE "safety_settings" ADD CONSTRAINT "safety_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_inductions" ADD CONSTRAINT "safety_inductions_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_inductions" ADD CONSTRAINT "safety_inductions_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "toolbox_talks" ADD CONSTRAINT "toolbox_talks_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "toolbox_talks" ADD CONSTRAINT "toolbox_talks_tenant_id_project_id_photo_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "photo_id") REFERENCES "site_photos"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "toolbox_talk_attendees" ADD CONSTRAINT "toolbox_talk_attendees_tenant_id_project_id_talk_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "talk_id") REFERENCES "toolbox_talks"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "toolbox_talk_attendees" ADD CONSTRAINT "toolbox_talk_attendees_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "toolbox_talk_attendees" ADD CONSTRAINT "toolbox_talk_attendees_tenant_id_project_id_via_gang_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "via_gang_id") REFERENCES "gangs"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ppe_issues" ADD CONSTRAINT "ppe_issues_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ppe_issues" ADD CONSTRAINT "ppe_issues_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ppe_issues" ADD CONSTRAINT "ppe_issues_tenant_id_project_id_replaces_issue_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "replaces_issue_id") REFERENCES "ppe_issues"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_tenant_id_project_id_follow_up_of_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "follow_up_of_id") REFERENCES "safety_incidents"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_incident_people" ADD CONSTRAINT "safety_incident_people_tenant_id_project_id_incident_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "incident_id") REFERENCES "safety_incidents"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_incident_people" ADD CONSTRAINT "safety_incident_people_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_incident_photos" ADD CONSTRAINT "safety_incident_photos_tenant_id_project_id_incident_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "incident_id") REFERENCES "safety_incidents"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_incident_photos" ADD CONSTRAINT "safety_incident_photos_tenant_id_project_id_photo_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "photo_id") REFERENCES "site_photos"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_tenant_id_project_id_incident_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "incident_id") REFERENCES "safety_incidents"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_tenant_id_project_id_inspection_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "inspection_id") REFERENCES "inspections"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_tenant_id_project_id_toolbox_talk_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "toolbox_talk_id") REFERENCES "toolbox_talks"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "first_aid_kits" ADD CONSTRAINT "first_aid_kits_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "first_aid_kit_checks" ADD CONSTRAINT "first_aid_kit_checks_tenant_id_project_id_kit_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "kit_id") REFERENCES "first_aid_kits"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "first_aiders" ADD CONSTRAINT "first_aiders_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "first_aiders" ADD CONSTRAINT "first_aiders_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "first_aid_treatments" ADD CONSTRAINT "first_aid_treatments_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "first_aid_treatments" ADD CONSTRAINT "first_aid_treatments_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "first_aid_treatments" ADD CONSTRAINT "first_aid_treatments_tenant_id_project_id_first_aider_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "first_aider_id") REFERENCES "first_aiders"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "first_aid_treatments" ADD CONSTRAINT "first_aid_treatments_tenant_id_project_id_incident_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "incident_id") REFERENCES "safety_incidents"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Shared helpers ---------------------------------------------------------------------------------
-- Closed and cancelled projects are read-only (packages/domain isProjectReadOnly). FOR SHARE waits
-- for a concurrent status change.
CREATE FUNCTION app.assert_safety_writable(target_tenant uuid, target_project uuid)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
BEGIN
  SELECT status INTO project_status FROM projects
    WHERE tenant_id = target_tenant AND id = target_project FOR SHARE;
  IF project_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
END
$$;

-- A labourer is engaged (now or before) on the project.
CREATE FUNCTION app.labourer_on_project(target_tenant uuid, target_project uuid,
  target_labourer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM labour_engagements
     WHERE tenant_id = target_tenant AND project_id = target_project
       AND labourer_id = target_labourer
  )
$$;

-- The induction checklist: 1–30 topics {key, label}, unique keys (packages/types
-- SAFETY_SETTINGS_LIMITS); a starter topic may have a null label.
CREATE FUNCTION app.valid_induction_topics(topics jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(topics) = 'array'
    AND jsonb_array_length(topics) BETWEEN 1 AND 30
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(topics) t
       WHERE jsonb_typeof(t) <> 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(t)) <> 2
          OR jsonb_typeof(t -> 'key') IS DISTINCT FROM 'string'
          OR (t ->> 'key') !~ '^[a-z0-9_]{2,40}$'
          OR jsonb_typeof(t -> 'label') NOT IN ('string', 'null')
          OR (jsonb_typeof(t -> 'label') = 'string'
              AND char_length(btrim(t ->> 'label')) NOT BETWEEN 2 AND 120)
    )
    AND (SELECT count(DISTINCT t ->> 'key') FROM jsonb_array_elements(topics) t)
      = jsonb_array_length(topics)
$$;

-- A whole number of days (1–3650) for every PPE item (packages/types PPE_ITEMS).
CREATE FUNCTION app.valid_ppe_replacement_days(days jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(days) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(days)) = 9
    AND days ?& ARRAY['helmet', 'safety_boots', 'reflective_vest', 'gloves', 'harness', 'goggles',
      'ear_protection', 'dust_mask', 'overalls']
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(days) e
       WHERE jsonb_typeof(e.value) <> 'number'
          OR (e.value)::numeric <> trunc((e.value)::numeric)
          OR (e.value)::numeric NOT BETWEEN 1 AND 3650
    )
$$;

-- Settings ---------------------------------------------------------------------------------------
ALTER TABLE "safety_settings" ADD CONSTRAINT "safety_settings_check" CHECK (
  app.valid_induction_topics(induction_topics)
  AND (induction_validity_days IS NULL OR induction_validity_days BETWEEN 30 AND 1095)
  AND induction_lookback_days BETWEEN 1 AND 90
  AND kit_check_interval_days BETWEEN 7 AND 180
  AND app.valid_ppe_replacement_days(ppe_replacement_days)
  AND version >= 1
);
CREATE FUNCTION app.guard_safety_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Settings are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'Settings start at version 1' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.tenant_id <> OLD.tenant_id OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'The company is fixed and the version must advance' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER safety_settings_guard BEFORE INSERT OR UPDATE ON "safety_settings"
  FOR EACH ROW EXECUTE FUNCTION app.guard_safety_settings();

-- Inductions -------------------------------------------------------------------------------------
-- packages/types INDUCTION_PERSON_KINDS, INDUCTION_ACKNOWLEDGEMENTS, INDUCTION_STATUSES.
ALTER TABLE "safety_inductions" ADD CONSTRAINT "safety_inductions_check" CHECK (
  number >= 1 AND version >= 1
  AND person_kind IN ('labourer', 'staff', 'visitor')
  AND (person_kind = 'labourer') = (labourer_id IS NOT NULL)
  AND (person_kind = 'staff') = (user_id IS NOT NULL)
  AND (person_kind = 'visitor') = (visitor_name IS NOT NULL)
  AND (visitor_organisation IS NULL OR person_kind = 'visitor')
  AND (visitor_name IS NULL
    OR (char_length(visitor_name) BETWEEN 2 AND 120 AND visitor_name = btrim(visitor_name)))
  AND (visitor_organisation IS NULL OR char_length(btrim(visitor_organisation)) BETWEEN 1 AND 120)
  AND app.valid_induction_topics(topics)
  AND topics_total BETWEEN jsonb_array_length(topics) AND 30
  AND acknowledgement IN ('signed', 'thumbprint', 'verbal')
  AND (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 500)
  AND status IN ('recorded', 'voided')
  AND (status = 'voided') = (voided_by IS NOT NULL)
  AND (status = 'voided') = (voided_at IS NOT NULL)
  AND (status = 'voided') = (void_reason IS NOT NULL)
  AND (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 3 AND 500)
);
CREATE FUNCTION app.guard_safety_induction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Inductions cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_safety_writable(NEW.tenant_id, NEW.project_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'recorded' OR NEW.version <> 1
      OR NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'An induction is recorded by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF NEW.inducted_on > app.business_today() THEN
      RAISE EXCEPTION 'An induction cannot be dated in the future' USING ERRCODE = '23514';
    END IF;
    IF NEW.labourer_id IS NOT NULL
      AND NOT app.labourer_on_project(NEW.tenant_id, NEW.project_id, NEW.labourer_id) THEN
      RAISE EXCEPTION 'The labourer is not engaged on this project' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
    SELECT max(number) INTO latest FROM safety_inductions
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Inductions are numbered in order' USING ERRCODE = '23514';
    END IF;
    NEW.recorded_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'Voided inductions are final' USING ERRCODE = '23514';
  END IF;
  -- Only the void columns change, once, by the signed-in user.
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.number, NEW.person_kind,
      NEW.labourer_id, NEW.user_id, NEW.visitor_name, NEW.visitor_organisation, NEW.inducted_on,
      NEW.inductor_id, NEW.topics, NEW.topics_total, NEW.acknowledgement, NEW.notes,
      NEW.recorded_by, NEW.recorded_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.number,
      OLD.person_kind, OLD.labourer_id, OLD.user_id, OLD.visitor_name, OLD.visitor_organisation,
      OLD.inducted_on, OLD.inductor_id, OLD.topics, OLD.topics_total, OLD.acknowledgement,
      OLD.notes, OLD.recorded_by, OLD.recorded_at)
    OR NEW.version <> OLD.version + 1 OR NEW.status <> 'voided'
    OR NEW.voided_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A recorded induction is fixed; it can only be voided' USING ERRCODE = '23514';
  END IF;
  NEW.voided_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER safety_induction_guard BEFORE INSERT OR UPDATE OR DELETE ON "safety_inductions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_safety_induction();

-- Toolbox talks ----------------------------------------------------------------------------------
-- packages/types TOOLBOX_TALK_STATUSES; packages/domain TOOLBOX_TALK_TRANSITIONS.
ALTER TABLE "toolbox_talks" ADD CONSTRAINT "toolbox_talks_check" CHECK (
  number >= 1 AND version >= 1
  AND char_length(topic) BETWEEN 3 AND 200 AND topic = btrim(topic)
  AND (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 2000)
  AND (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 240)
  AND other_attendees BETWEEN 0 AND 500
  AND COALESCE(CASE status
    WHEN 'draft' THEN confirmed_by IS NULL AND confirmed_at IS NULL AND cancelled_by IS NULL
      AND cancelled_at IS NULL AND cancel_reason IS NULL
    WHEN 'confirmed' THEN confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
      AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL
    WHEN 'cancelled' THEN confirmed_by IS NULL AND confirmed_at IS NULL
      AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL
    ELSE false END, false)
  AND (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 3 AND 500)
);
CREATE FUNCTION app.guard_toolbox_talk() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  attendees integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Toolbox talks cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_safety_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Toolbox talks are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.held_on > app.business_today() THEN
    RAISE EXCEPTION 'A toolbox talk cannot be dated in the future' USING ERRCODE = '23514';
  END IF;
  IF NEW.photo_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM site_photos
       WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.photo_id
         AND site_id = NEW.site_id) THEN
    RAISE EXCEPTION 'The photo must be from the talk''s site' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.version <> 1
      OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A toolbox talk starts as the signed-in user''s draft'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
    SELECT max(number) INTO latest FROM toolbox_talks
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Toolbox talks are numbered in order' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Confirmed and cancelled toolbox talks are locked' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.number, NEW.created_by,
      NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.number,
      OLD.created_by, OLD.created_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Toolbox talk identity is fixed and its version must advance'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'confirmed' THEN
    IF NEW.confirmed_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A toolbox talk is confirmed by the signed-in user' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO attendees FROM toolbox_talk_attendees
      WHERE tenant_id = NEW.tenant_id AND talk_id = NEW.id;
    IF attendees + NEW.other_attendees < 1 THEN
      RAISE EXCEPTION 'A toolbox talk needs at least one attendee' USING ERRCODE = '23514';
    END IF;
    NEW.confirmed_at := now();
  ELSIF NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A toolbox talk is cancelled by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.cancelled_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER toolbox_talk_guard BEFORE INSERT OR UPDATE OR DELETE ON "toolbox_talks"
  FOR EACH ROW EXECUTE FUNCTION app.guard_toolbox_talk();

-- Attendees are labourers engaged on the project, added or removed only while the talk is a draft
-- (at most 200, packages/types SAFETY_LIMITS.maxTalkAttendees).
CREATE FUNCTION app.guard_toolbox_talk_attendee() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target toolbox_talk_attendees%ROWTYPE;
  parent toolbox_talks%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Toolbox talk attendees are added or removed, never changed'
      USING ERRCODE = '42501';
  END IF;
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  SELECT * INTO parent FROM toolbox_talks
    WHERE tenant_id = target.tenant_id AND project_id = target.project_id AND id = target.talk_id
    FOR SHARE;
  -- Only a cascade from a talk that is already gone skips the checks; a delete issued from any
  -- other trigger is checked like a direct one.
  IF TG_OP = 'DELETE' AND parent.id IS NULL THEN
    RETURN OLD;
  END IF;
  PERFORM app.assert_safety_writable(target.tenant_id, target.project_id);
  IF parent.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Attendance changes only while the toolbox talk is a draft'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.added_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Attendees are added by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NOT app.labourer_on_project(NEW.tenant_id, NEW.project_id, NEW.labourer_id) THEN
    RAISE EXCEPTION 'The labourer is not engaged on this project' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM toolbox_talk_attendees
       WHERE tenant_id = NEW.tenant_id AND talk_id = NEW.talk_id) >= 200 THEN
    RAISE EXCEPTION 'A toolbox talk holds at most 200 registered attendees'
      USING ERRCODE = '23514';
  END IF;
  NEW.added_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER toolbox_talk_attendee_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "toolbox_talk_attendees" FOR EACH ROW EXECUTE FUNCTION app.guard_toolbox_talk_attendee();

-- PPE register -----------------------------------------------------------------------------------
-- packages/types PPE_ITEMS, PPE_ISSUE_STATUSES, PPE_RETURN_CONDITIONS, SAFETY_LIMITS.maxPpeQuantity.
ALTER TABLE "ppe_issues" ADD CONSTRAINT "ppe_issues_check" CHECK (
  version >= 1
  AND item IN ('helmet', 'safety_boots', 'reflective_vest', 'gloves', 'harness', 'goggles',
    'ear_protection', 'dust_mask', 'overalls')
  AND (size IS NULL OR (char_length(size) BETWEEN 1 AND 12 AND size = btrim(size)))
  AND quantity BETWEEN 1 AND 20
  AND replacement_days BETWEEN 1 AND 3650
  AND replacement_due_on = issued_on + replacement_days
  AND (replaces_issue_id IS NULL OR replaces_issue_id <> id)
  AND status IN ('issued', 'returned', 'replaced', 'voided')
  AND (status = 'returned') = (returned_on IS NOT NULL)
  AND (status = 'returned') = (return_condition IS NOT NULL)
  AND (status = 'returned') = (returned_by IS NOT NULL)
  AND (status = 'returned') = (returned_at IS NOT NULL)
  AND (return_condition IS NULL OR return_condition IN ('good', 'damaged', 'lost'))
  AND (returned_on IS NULL OR returned_on >= issued_on)
  AND (status = 'voided') = (voided_by IS NOT NULL)
  AND (status = 'voided') = (voided_at IS NOT NULL)
  AND (status = 'voided') = (void_reason IS NOT NULL)
  AND (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 3 AND 500)
);
CREATE FUNCTION app.guard_ppe_issue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  replaced ppe_issues%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PPE issues cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_safety_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'PPE issues are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'issued' OR NEW.version <> 1
      OR NEW.issued_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'PPE is issued by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF NEW.issued_on > app.business_today() THEN
      RAISE EXCEPTION 'PPE cannot be issued in the future' USING ERRCODE = '23514';
    END IF;
    IF NOT app.labourer_on_project(NEW.tenant_id, NEW.project_id, NEW.labourer_id) THEN
      RAISE EXCEPTION 'The labourer is not engaged on this project' USING ERRCODE = '23514';
    END IF;
    IF NEW.replaces_issue_id IS NOT NULL THEN
      SELECT * INTO replaced FROM ppe_issues
        WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
          AND id = NEW.replaces_issue_id FOR UPDATE;
      IF replaced.status IS DISTINCT FROM 'issued' OR replaced.labourer_id <> NEW.labourer_id
        OR replaced.item <> NEW.item OR NEW.issued_on < replaced.issued_on THEN
        RAISE EXCEPTION 'A replacement follows an item still issued to the same labourer'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    NEW.issued_at := now();
    RETURN NEW;
  END IF;
  -- A replacement voided as a mistake puts the item it replaced back in use.
  IF OLD.status = 'replaced' AND NEW.status = 'issued' THEN
    IF EXISTS (SELECT 1 FROM ppe_issues
        WHERE tenant_id = OLD.tenant_id AND replaces_issue_id = OLD.id AND status <> 'voided') THEN
      RAISE EXCEPTION 'A replaced item is back in use only when its replacement is voided'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status <> 'issued' THEN
    RAISE EXCEPTION 'Returned, replaced and voided PPE issues are final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.labourer_id, NEW.item, NEW.size,
      NEW.quantity, NEW.issued_on, NEW.replacement_days, NEW.replacement_due_on,
      NEW.replaces_issue_id, NEW.issued_by, NEW.issued_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.labourer_id,
      OLD.item, OLD.size, OLD.quantity, OLD.issued_on, OLD.replacement_days,
      OLD.replacement_due_on, OLD.replaces_issue_id, OLD.issued_by, OLD.issued_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'A PPE issue is fixed; it can only be returned, replaced or voided'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'replaced' THEN
    RETURN NEW;
  ELSIF NEW.status = 'returned' THEN
    IF NEW.returned_by IS DISTINCT FROM app.current_user_id()
      OR NEW.returned_on > app.business_today() THEN
      RAISE EXCEPTION 'A return is recorded by the signed-in user, not in the future'
        USING ERRCODE = '23514';
    END IF;
    NEW.returned_at := now();
  ELSIF NEW.status = 'replaced' THEN
    IF NOT EXISTS (SELECT 1 FROM ppe_issues
        WHERE tenant_id = NEW.tenant_id AND replaces_issue_id = NEW.id) THEN
      RAISE EXCEPTION 'An item is replaced only by a newer issue naming it'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'voided' THEN
    IF NEW.voided_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A PPE issue is voided by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.voided_at := now();
  ELSE
    RAISE EXCEPTION 'Invalid PPE issue transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ppe_issue_guard BEFORE INSERT OR UPDATE OR DELETE ON "ppe_issues"
  FOR EACH ROW EXECUTE FUNCTION app.guard_ppe_issue();

-- Incidents --------------------------------------------------------------------------------------
-- packages/types INCIDENT_KINDS, INCIDENT_SEVERITIES, INCIDENT_STATUSES, ROOT_CAUSE_CATEGORIES,
-- REGULATOR_DECISIONS; packages/domain INCIDENT_TRANSITIONS, incidentCloseBlockers.
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_check" CHECK (
  number >= 1 AND version >= 1
  AND kind IN ('injury', 'near_miss', 'property_damage', 'environmental', 'dangerous_occurrence')
  AND severity IN ('minor', 'moderate', 'serious', 'fatal')
  AND char_length(location) BETWEEN 2 AND 200 AND location = btrim(location)
  AND char_length(btrim(description)) BETWEEN 10 AND 2000
  AND (immediate_actions IS NULL OR char_length(btrim(immediate_actions)) BETWEEN 1 AND 2000)
  AND status IN ('reported', 'investigated', 'closed', 'voided')
  -- The investigation: all of it or none of it; required once investigated.
  AND (root_cause IS NULL) = (root_cause_category IS NULL)
  AND (root_cause IS NULL) = (investigated_by IS NULL)
  AND (root_cause IS NULL) = (investigated_at IS NULL)
  AND (contributing_factors IS NULL OR root_cause IS NOT NULL)
  AND (root_cause_category IS NULL OR root_cause_category IN ('unsafe_act', 'unsafe_condition',
    'equipment_failure', 'lack_of_training', 'lack_of_ppe', 'procedure_not_followed',
    'supervision', 'environment', 'other'))
  AND (root_cause IS NULL OR char_length(btrim(root_cause)) BETWEEN 10 AND 2000)
  AND (contributing_factors IS NULL OR char_length(btrim(contributing_factors)) BETWEEN 1 AND 2000)
  AND (status NOT IN ('investigated', 'closed') OR root_cause IS NOT NULL)
  AND (status <> 'reported' OR root_cause IS NULL)
  -- The regulator decision: notified (date, optional reference) or not notifiable (reason).
  AND (regulator_decision IS NULL OR regulator_decision IN ('notified', 'not_notifiable'))
  AND (regulator_decision IS NULL) = (regulator_decided_by IS NULL)
  AND (regulator_decision IS NULL) = (regulator_decided_at IS NULL)
  AND CASE
    WHEN regulator_decision IS NULL THEN regulator_notified_on IS NULL
      AND regulator_reference IS NULL AND regulator_reason IS NULL
    WHEN regulator_decision = 'notified' THEN regulator_notified_on IS NOT NULL
      AND regulator_reason IS NULL
    ELSE regulator_reason IS NOT NULL AND regulator_notified_on IS NULL
      AND regulator_reference IS NULL END
  AND (regulator_reference IS NULL OR char_length(btrim(regulator_reference)) BETWEEN 1 AND 60)
  AND (regulator_reason IS NULL OR char_length(btrim(regulator_reason)) BETWEEN 3 AND 500)
  -- Closing and voiding.
  AND (status = 'closed') = (closed_by IS NOT NULL)
  AND (status = 'closed') = (closed_at IS NOT NULL)
  AND (closure_note IS NULL OR (status = 'closed' AND char_length(btrim(closure_note)) BETWEEN 1 AND 1000))
  AND (no_action_reason IS NULL OR (status = 'closed' AND char_length(btrim(no_action_reason)) BETWEEN 3 AND 500))
  AND (status = 'voided') = (voided_by IS NOT NULL)
  AND (status = 'voided') = (voided_at IS NOT NULL)
  AND (status = 'voided') = (void_reason IS NOT NULL)
  AND (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 3 AND 500)
  AND (follow_up_of_id IS NULL OR follow_up_of_id <> id)
);

-- Corrective actions of an incident that are still open or done, and those verified.
CREATE FUNCTION app.incident_action_counts(target_tenant uuid, target_incident uuid,
  OUT outstanding integer, OUT verified integer) LANGUAGE sql STABLE AS $$
  SELECT (count(*) FILTER (WHERE status IN ('open', 'done')))::integer,
         (count(*) FILTER (WHERE status = 'verified'))::integer
    FROM corrective_actions
   WHERE tenant_id = target_tenant AND incident_id = target_incident
$$;

CREATE FUNCTION app.guard_safety_incident() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  original text;
  counts record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Incidents cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_safety_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Incidents are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.occurred_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'An incident cannot have happened in the future' USING ERRCODE = '23514';
  END IF;
  IF NEW.regulator_notified_on > app.business_today() THEN
    RAISE EXCEPTION 'A notification date cannot be in the future' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reported' OR NEW.version <> 1 OR NEW.root_cause IS NOT NULL
      OR NEW.regulator_decision IS NOT NULL
      OR NEW.reported_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'An incident is reported by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF NEW.follow_up_of_id IS NOT NULL THEN
      SELECT status INTO original FROM safety_incidents
        WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.follow_up_of_id;
      IF original IS DISTINCT FROM 'closed' THEN
        RAISE EXCEPTION 'A follow-up refers to a closed incident' USING ERRCODE = '23514';
      END IF;
    END IF;
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
    SELECT max(number) INTO latest FROM safety_incidents
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Incidents are numbered in order' USING ERRCODE = '23514';
    END IF;
    NEW.reported_at := now();
    RETURN NEW;
  END IF;
  -- INVARIANT: a closed (or voided) incident is immutable, whoever asks.
  IF OLD.status IN ('closed', 'voided') THEN
    RAISE EXCEPTION 'Closed and voided incidents are locked' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.number, NEW.reported_by,
      NEW.reported_at, NEW.follow_up_of_id)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.number,
      OLD.reported_by, OLD.reported_at, OLD.follow_up_of_id)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Incident identity is fixed and its version must advance'
      USING ERRCODE = '23514';
  END IF;
  -- A changed investigation is stamped with its author and the database clock.
  IF ROW(NEW.root_cause_category, NEW.root_cause, NEW.contributing_factors)
    IS DISTINCT FROM ROW(OLD.root_cause_category, OLD.root_cause, OLD.contributing_factors) THEN
    IF NEW.investigated_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'An investigation is recorded by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.investigated_at := now();
  ELSIF ROW(NEW.investigated_by, NEW.investigated_at)
    IS DISTINCT FROM ROW(OLD.investigated_by, OLD.investigated_at) THEN
    RAISE EXCEPTION 'The investigation''s author changes only with the investigation'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.regulator_decision, NEW.regulator_notified_on, NEW.regulator_reference,
      NEW.regulator_reason)
    IS DISTINCT FROM ROW(OLD.regulator_decision, OLD.regulator_notified_on,
      OLD.regulator_reference, OLD.regulator_reason) THEN
    IF NEW.regulator_decided_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A regulator decision is recorded by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    NEW.regulator_decided_at := now();
  ELSIF ROW(NEW.regulator_decided_by, NEW.regulator_decided_at)
    IS DISTINCT FROM ROW(OLD.regulator_decided_by, OLD.regulator_decided_at) THEN
    RAISE EXCEPTION 'The regulator decision''s author changes only with the decision'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status OR (OLD.status = 'reported' AND NEW.status = 'investigated') THEN
    RETURN NEW;
  END IF;
  -- Closing and voiding change nothing else.
  IF ROW(NEW.kind, NEW.severity, NEW.occurred_at, NEW.location, NEW.description,
      NEW.immediate_actions, NEW.first_aid_given, NEW.root_cause_category, NEW.root_cause,
      NEW.contributing_factors, NEW.regulator_decision, NEW.regulator_notified_on,
      NEW.regulator_reference, NEW.regulator_reason)
    IS DISTINCT FROM ROW(OLD.kind, OLD.severity, OLD.occurred_at, OLD.location, OLD.description,
      OLD.immediate_actions, OLD.first_aid_given, OLD.root_cause_category, OLD.root_cause,
      OLD.contributing_factors, OLD.regulator_decision, OLD.regulator_notified_on,
      OLD.regulator_reference, OLD.regulator_reason) THEN
    RAISE EXCEPTION 'Content cannot change while closing or voiding' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO counts FROM app.incident_action_counts(NEW.tenant_id, NEW.id);
  IF OLD.status = 'investigated' AND NEW.status = 'closed' THEN
    IF NEW.closed_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'An incident is closed by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF counts.outstanding > 0 THEN
      RAISE EXCEPTION 'Every corrective action must be verified or cancelled before closing'
        USING ERRCODE = '23514';
    END IF;
    IF counts.verified = 0 AND NEW.no_action_reason IS NULL THEN
      RAISE EXCEPTION 'Closing needs a verified corrective action or a reason for none'
        USING ERRCODE = '23514';
    END IF;
    IF (NEW.kind = 'dangerous_occurrence'
        OR (NEW.kind = 'injury' AND NEW.severity IN ('serious', 'fatal')))
      AND NEW.regulator_decision IS NULL THEN
      RAISE EXCEPTION 'Record the regulator decision before closing' USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := now();
  ELSIF OLD.status IN ('reported', 'investigated') AND NEW.status = 'voided' THEN
    IF NEW.voided_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'An incident is voided by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF counts.outstanding > 0 THEN
      RAISE EXCEPTION 'Cancel the open corrective actions before voiding' USING ERRCODE = '23514';
    END IF;
    NEW.voided_at := now();
  ELSE
    RAISE EXCEPTION 'Invalid incident transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER safety_incident_guard BEFORE INSERT OR UPDATE OR DELETE ON "safety_incidents"
  FOR EACH ROW EXECUTE FUNCTION app.guard_safety_incident();

-- packages/types INCIDENT_PERSON_ROLES, INJURY_TYPES, BODY_PARTS: one reference per person and
-- the two injury codes for (and only for) the injured.
ALTER TABLE "safety_incident_people" ADD CONSTRAINT "safety_incident_people_check" CHECK (
  role IN ('injured', 'involved', 'witness')
  AND num_nonnulls(labourer_id, user_id, name) = 1
  AND (name IS NULL OR (char_length(name) BETWEEN 2 AND 120 AND name = btrim(name)))
  AND (role = 'injured') = (injury_type IS NOT NULL)
  AND (role = 'injured') = (body_part IS NOT NULL)
  AND (injury_type IS NULL OR injury_type IN ('cut', 'bruise', 'fracture', 'sprain', 'burn',
    'eye_injury', 'crush', 'electric_shock', 'other'))
  AND (body_part IS NULL OR body_part IN ('head', 'eye', 'face', 'neck', 'back', 'trunk', 'arm',
    'hand', 'leg', 'foot', 'multiple', 'other'))
);
-- People are listed while the incident is open (reported or investigated); afterwards they are
-- locked with it.
CREATE FUNCTION app.guard_safety_incident_person() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target safety_incident_people%ROWTYPE;
  parent safety_incidents%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Incident people are added or removed, never changed' USING ERRCODE = '42501';
  END IF;
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  SELECT * INTO parent FROM safety_incidents
    WHERE tenant_id = target.tenant_id AND project_id = target.project_id
      AND id = target.incident_id FOR SHARE;
  -- Only a cascade from an incident that is already gone skips the checks.
  IF TG_OP = 'DELETE' AND parent.id IS NULL THEN
    RETURN OLD;
  END IF;
  PERFORM app.assert_safety_writable(target.tenant_id, target.project_id);
  IF parent.status IS DISTINCT FROM 'reported' AND parent.status IS DISTINCT FROM 'investigated' THEN
    RAISE EXCEPTION 'People change only while the incident is open' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.added_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'People are added by the signed-in user' USING ERRCODE = '23514';
  END IF;
  NEW.added_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER safety_incident_person_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "safety_incident_people" FOR EACH ROW EXECUTE FUNCTION app.guard_safety_incident_person();

-- At commit: an injury names at least one injured person and a near miss names none.
CREATE FUNCTION app.check_incident_people() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_tenant uuid;
  target_incident uuid;
  incident_kind text;
  injured integer;
BEGIN
  IF TG_TABLE_NAME = 'safety_incidents' THEN
    target_tenant := NEW.tenant_id;
    target_incident := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_incident := OLD.incident_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_incident := NEW.incident_id;
  END IF;
  SELECT kind INTO incident_kind FROM safety_incidents
    WHERE tenant_id = target_tenant AND id = target_incident;
  IF incident_kind IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO injured FROM safety_incident_people
    WHERE tenant_id = target_tenant AND incident_id = target_incident AND role = 'injured';
  IF incident_kind = 'injury' AND injured = 0 THEN
    RAISE EXCEPTION 'An injury names at least one injured person' USING ERRCODE = '23514';
  END IF;
  IF incident_kind = 'near_miss' AND injured > 0 THEN
    RAISE EXCEPTION 'A near miss has no injured person' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER safety_incident_people_complete AFTER INSERT OR UPDATE
  ON "safety_incidents" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_incident_people();
CREATE CONSTRAINT TRIGGER safety_incident_people_kind AFTER INSERT OR DELETE
  ON "safety_incident_people" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_incident_people();

-- Incident photos can show injured people (D-74): they are uploaded as `safety_incident` site
-- photos, kept off diaries and out of the project's photo list, and opened only by health and
-- safety readers (packages/domain PHOTO_PURPOSES; the API enforces who reads them).
ALTER TABLE "site_photos" ADD COLUMN "purpose" VARCHAR(20) NOT NULL DEFAULT 'general';
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_purpose_check" CHECK (
  purpose IN ('general', 'safety_incident') AND (purpose = 'general' OR diary_id IS NULL)
);

-- Photos are incident photos of the incident's site, added while it is open (at most six,
-- packages/types SAFETY_LIMITS.maxIncidentPhotos); never removed or changed.
CREATE FUNCTION app.guard_safety_incident_photo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent safety_incidents%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only a cascade from an incident that is already gone.
    IF NOT EXISTS (SELECT 1 FROM safety_incidents
        WHERE tenant_id = OLD.tenant_id AND project_id = OLD.project_id AND id = OLD.incident_id)
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Incident photos cannot be removed' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Incident photos cannot be changed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO parent FROM safety_incidents
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.incident_id
    FOR SHARE;
  PERFORM app.assert_safety_writable(NEW.tenant_id, NEW.project_id);
  IF parent.status IS DISTINCT FROM 'reported' AND parent.status IS DISTINCT FROM 'investigated' THEN
    RAISE EXCEPTION 'Photos are added while the incident is open' USING ERRCODE = '23514';
  END IF;
  IF NEW.added_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Photos are added by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM site_photos
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.photo_id
        AND site_id = parent.site_id AND purpose = 'safety_incident') THEN
    RAISE EXCEPTION 'The photo must be an incident photo from the incident''s site'
      USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM safety_incident_photos
       WHERE tenant_id = NEW.tenant_id AND incident_id = NEW.incident_id) >= 6 THEN
    RAISE EXCEPTION 'An incident holds at most six photos' USING ERRCODE = '23514';
  END IF;
  NEW.added_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER safety_incident_photo_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "safety_incident_photos" FOR EACH ROW EXECUTE FUNCTION app.guard_safety_incident_photo();

-- Corrective actions -----------------------------------------------------------------------------
-- packages/types CORRECTIVE_ACTION_SOURCES, CORRECTIVE_ACTION_STATUSES; packages/domain
-- CORRECTIVE_ACTION_TRANSITIONS, correctiveActionVerifierIndependent.
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_check" CHECK (
  number >= 1 AND version >= 1
  AND source IN ('incident', 'inspection', 'toolbox_talk', 'other')
  AND (source = 'incident') = (incident_id IS NOT NULL)
  AND (source = 'inspection') = (inspection_id IS NOT NULL)
  AND (source = 'toolbox_talk') = (toolbox_talk_id IS NOT NULL)
  AND char_length(btrim(description)) BETWEEN 5 AND 1000
  AND reject_count >= 0 AND (reject_count = 0) = (last_reject_reason IS NULL)
  AND (last_reject_reason IS NULL OR char_length(btrim(last_reject_reason)) BETWEEN 3 AND 500)
  AND (done_note IS NULL OR char_length(btrim(done_note)) BETWEEN 3 AND 1000)
  AND COALESCE(CASE status
    WHEN 'open' THEN done_by IS NULL AND done_at IS NULL AND done_note IS NULL
      AND verified_by IS NULL AND verified_at IS NULL AND cancelled_by IS NULL
    WHEN 'done' THEN done_by IS NOT NULL AND done_at IS NOT NULL AND done_by = owner_id
      AND verified_by IS NULL AND verified_at IS NULL AND cancelled_by IS NULL
    WHEN 'verified' THEN done_by IS NOT NULL AND done_at IS NOT NULL AND done_by = owner_id
      AND verified_by IS NOT NULL AND verified_at IS NOT NULL
      AND verified_by <> owner_id AND verified_by <> done_by AND cancelled_by IS NULL
    WHEN 'cancelled' THEN verified_by IS NULL AND verified_at IS NULL
      AND cancelled_by IS NOT NULL
    ELSE false END, false)
  AND (status = 'cancelled') = (cancelled_by IS NOT NULL)
  AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
  AND (status = 'cancelled') = (cancel_reason IS NOT NULL)
  AND (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 3 AND 500)
);
CREATE FUNCTION app.guard_corrective_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Corrective actions cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_safety_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Corrective actions are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  -- An action of a closed or voided incident is locked with it; new ones are refused.
  IF NEW.incident_id IS NOT NULL THEN
    SELECT status INTO parent_status FROM safety_incidents
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.incident_id
      FOR SHARE;
    IF parent_status IN ('closed', 'voided') THEN
      RAISE EXCEPTION 'Corrective actions of a closed or voided incident are locked'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1 OR NEW.reject_count <> 0
      OR NEW.raised_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A corrective action is raised open by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.toolbox_talk_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM toolbox_talks
        WHERE tenant_id = NEW.tenant_id AND id = NEW.toolbox_talk_id AND status = 'confirmed') THEN
      RAISE EXCEPTION 'Actions are raised from confirmed toolbox talks' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
    SELECT max(number) INTO latest FROM corrective_actions
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Corrective actions are numbered in order' USING ERRCODE = '23514';
    END IF;
    NEW.raised_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status IN ('verified', 'cancelled') THEN
    RAISE EXCEPTION 'Verified and cancelled corrective actions are final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.number, NEW.source, NEW.incident_id,
      NEW.inspection_id, NEW.toolbox_talk_id, NEW.raised_by, NEW.raised_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.number, OLD.source,
      OLD.incident_id, OLD.inspection_id, OLD.toolbox_talk_id, OLD.raised_by, OLD.raised_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Corrective action identity is fixed and its version must advance'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    -- Edits (description, owner, due date) while open; a done action waits for its verifier.
    IF OLD.status <> 'open' OR ROW(NEW.done_by, NEW.done_at, NEW.done_note, NEW.reject_count,
        NEW.last_reject_reason) IS DISTINCT FROM ROW(OLD.done_by, OLD.done_at, OLD.done_note,
        OLD.reject_count, OLD.last_reject_reason) THEN
      RAISE EXCEPTION 'Only an open corrective action can be edited' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.description, NEW.owner_id, NEW.due_on)
    IS DISTINCT FROM ROW(OLD.description, OLD.owner_id, OLD.due_on) THEN
    RAISE EXCEPTION 'Content cannot change with a transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'done' THEN
    IF app.current_user_id() IS DISTINCT FROM OLD.owner_id
      OR NEW.done_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'Only the action''s owner marks it done' USING ERRCODE = '23514';
    END IF;
    NEW.done_at := now();
  ELSIF OLD.status = 'done' AND NEW.status = 'verified' THEN
    IF NEW.verified_by IS DISTINCT FROM app.current_user_id()
      OR app.current_user_id() IN (OLD.owner_id, OLD.done_by)
      OR ROW(NEW.done_by, NEW.done_at, NEW.done_note)
        IS DISTINCT FROM ROW(OLD.done_by, OLD.done_at, OLD.done_note) THEN
      RAISE EXCEPTION 'Someone other than the owner verifies a corrective action'
        USING ERRCODE = '23514';
    END IF;
    NEW.verified_at := now();
  ELSIF OLD.status = 'done' AND NEW.status = 'open' THEN
    IF app.current_user_id() IN (OLD.owner_id, OLD.done_by)
      OR NEW.reject_count <> OLD.reject_count + 1 OR NEW.last_reject_reason IS NULL THEN
      RAISE EXCEPTION 'Someone other than the owner rejects a corrective action with a reason'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A corrective action is cancelled by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    NEW.cancelled_at := now();
  ELSE
    RAISE EXCEPTION 'Invalid corrective action transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER corrective_action_guard BEFORE INSERT OR UPDATE OR DELETE ON "corrective_actions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_corrective_action();

-- First-aid kits and checks ----------------------------------------------------------------------
ALTER TABLE "first_aid_kits" ADD CONSTRAINT "first_aid_kits_check" CHECK (
  version >= 1
  AND char_length(label) BETWEEN 2 AND 80 AND label = btrim(label)
  AND (location IS NULL OR char_length(btrim(location)) BETWEEN 1 AND 200)
  AND status IN ('active', 'retired')
  AND (status = 'retired') = (retired_by IS NOT NULL)
  AND (status = 'retired') = (retired_at IS NOT NULL)
  AND (status = 'retired') = (retired_reason IS NOT NULL)
  AND (retired_reason IS NULL OR char_length(btrim(retired_reason)) BETWEEN 3 AND 500)
);
CREATE FUNCTION app.guard_first_aid_kit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'First-aid kits cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_safety_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Kits are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.version <> 1
      OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A kit is added active by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'Retired kits are final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.label, NEW.location,
      NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.label,
      OLD.location, OLD.created_by, OLD.created_at)
    OR NEW.version <> OLD.version + 1 OR NEW.status <> 'retired'
    OR NEW.retired_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A kit can only be retired' USING ERRCODE = '23514';
  END IF;
  NEW.retired_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER first_aid_kit_guard BEFORE INSERT OR UPDATE OR DELETE ON "first_aid_kits"
  FOR EACH ROW EXECUTE FUNCTION app.guard_first_aid_kit();

ALTER TABLE "first_aid_kit_checks" ADD CONSTRAINT "first_aid_kit_checks_check" CHECK (
  outcome IN ('complete', 'restocked', 'incomplete')
  AND (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 500)
);
-- Checks are append-only evidence of an active kit, dated no later than today.
CREATE FUNCTION app.guard_first_aid_kit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kit_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only a cascade from a kit that is already gone.
    IF NOT EXISTS (SELECT 1 FROM first_aid_kits
        WHERE tenant_id = OLD.tenant_id AND project_id = OLD.project_id AND id = OLD.kit_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'first_aid_kit_checks rows are append-only' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'first_aid_kit_checks rows are append-only' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_safety_writable(NEW.tenant_id, NEW.project_id);
  SELECT status INTO kit_status FROM first_aid_kits
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.kit_id FOR SHARE;
  IF kit_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Only an active kit is checked' USING ERRCODE = '23514';
  END IF;
  IF NEW.checked_by IS DISTINCT FROM app.current_user_id()
    OR NEW.checked_on > app.business_today() THEN
    RAISE EXCEPTION 'A check is recorded by the signed-in user, not in the future'
      USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER first_aid_kit_check_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "first_aid_kit_checks" FOR EACH ROW EXECUTE FUNCTION app.guard_first_aid_kit_check();

-- First-aiders -----------------------------------------------------------------------------------
ALTER TABLE "first_aiders" ADD CONSTRAINT "first_aiders_check" CHECK (
  version >= 1
  AND num_nonnulls(labourer_id, user_id) = 1
  AND (certificate_reference IS NULL OR char_length(btrim(certificate_reference)) BETWEEN 1 AND 60)
  AND status IN ('active', 'removed')
  AND (status = 'removed') = (removed_by IS NOT NULL)
  AND (status = 'removed') = (removed_at IS NOT NULL)
  AND (status = 'removed') = (removed_reason IS NOT NULL)
  AND (removed_reason IS NULL OR char_length(btrim(removed_reason)) BETWEEN 3 AND 500)
);
CREATE UNIQUE INDEX "first_aiders_one_active_labourer" ON "first_aiders"
  ("tenant_id", "site_id", "labourer_id") WHERE status = 'active' AND labourer_id IS NOT NULL;
CREATE UNIQUE INDEX "first_aiders_one_active_user" ON "first_aiders"
  ("tenant_id", "site_id", "user_id") WHERE status = 'active' AND user_id IS NOT NULL;
CREATE FUNCTION app.guard_first_aider() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'First-aiders cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_safety_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'First-aiders are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.version <> 1
      OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A first-aider is added active by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.labourer_id IS NOT NULL
      AND NOT app.labourer_on_project(NEW.tenant_id, NEW.project_id, NEW.labourer_id) THEN
      RAISE EXCEPTION 'The labourer is not engaged on this project' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'removed' THEN
    RAISE EXCEPTION 'Removed first-aiders are final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.labourer_id, NEW.user_id,
      NEW.certificate_expires_on, NEW.certificate_reference, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.labourer_id,
      OLD.user_id, OLD.certificate_expires_on, OLD.certificate_reference, OLD.created_by,
      OLD.created_at)
    OR NEW.version <> OLD.version + 1 OR NEW.status <> 'removed'
    OR NEW.removed_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A first-aider can only be removed (a renewed certificate is a new entry)'
      USING ERRCODE = '23514';
  END IF;
  NEW.removed_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER first_aider_guard BEFORE INSERT OR UPDATE OR DELETE ON "first_aiders"
  FOR EACH ROW EXECUTE FUNCTION app.guard_first_aider();

-- First-aid treatments ---------------------------------------------------------------------------
-- packages/types INJURY_TYPES, FIRST_AID_TREATMENTS, FIRST_AID_REFERRALS, TREATMENT_STATUSES.
ALTER TABLE "first_aid_treatments" ADD CONSTRAINT "first_aid_treatments_check" CHECK (
  number >= 1 AND version >= 1
  AND num_nonnulls(labourer_id, person_name) = 1
  AND (person_name IS NULL
    OR (char_length(person_name) BETWEEN 2 AND 120 AND person_name = btrim(person_name)))
  AND injury_type IN ('cut', 'bruise', 'fracture', 'sprain', 'burn', 'eye_injury', 'crush',
    'electric_shock', 'other')
  AND treatment IN ('cleaned_dressed', 'bandaged', 'eye_wash', 'cold_compress', 'burn_dressing',
    'rest_observation', 'other')
  AND referral IN ('none', 'clinic', 'hospital')
  AND status IN ('recorded', 'voided')
  AND (status = 'voided') = (voided_by IS NOT NULL)
  AND (status = 'voided') = (voided_at IS NOT NULL)
  AND (status = 'voided') = (void_reason IS NOT NULL)
  AND (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 3 AND 500)
);
CREATE FUNCTION app.guard_first_aid_treatment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  incident_status text;
  aider first_aiders%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Treatments cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_safety_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Treatments are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  -- A treatment linked to a closed or voided incident is locked with it.
  IF TG_OP = 'UPDATE' AND OLD.incident_id IS NOT NULL THEN
    SELECT status INTO incident_status FROM safety_incidents
      WHERE tenant_id = OLD.tenant_id AND project_id = OLD.project_id AND id = OLD.incident_id
      FOR SHARE;
    IF incident_status IN ('closed', 'voided') THEN
      RAISE EXCEPTION 'Treatments of a closed or voided incident are locked'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.incident_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW.incident_id IS DISTINCT FROM OLD.incident_id) THEN
    SELECT status INTO incident_status FROM safety_incidents
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.incident_id
      FOR SHARE;
    IF incident_status IS DISTINCT FROM 'reported'
      AND incident_status IS DISTINCT FROM 'investigated' THEN
      RAISE EXCEPTION 'Treatments are linked to open incidents' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'recorded' OR NEW.version <> 1
      OR NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A treatment is recorded by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF NEW.treated_at > now() + interval '5 minutes' THEN
      RAISE EXCEPTION 'A treatment cannot be in the future' USING ERRCODE = '23514';
    END IF;
    IF NEW.first_aider_id IS NOT NULL THEN
      SELECT * INTO aider FROM first_aiders
        WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
          AND id = NEW.first_aider_id;
      IF aider.site_id IS DISTINCT FROM NEW.site_id THEN
        RAISE EXCEPTION 'The first-aider must be one of the site''s' USING ERRCODE = '23514';
      END IF;
    END IF;
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
    SELECT max(number) INTO latest FROM first_aid_treatments
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Treatments are numbered in order' USING ERRCODE = '23514';
    END IF;
    NEW.recorded_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'Voided treatments are final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.number, NEW.treated_at,
      NEW.labourer_id, NEW.person_name, NEW.injury_type, NEW.treatment, NEW.referral,
      NEW.first_aider_id, NEW.recorded_by, NEW.recorded_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.number,
      OLD.treated_at, OLD.labourer_id, OLD.person_name, OLD.injury_type, OLD.treatment,
      OLD.referral, OLD.first_aider_id, OLD.recorded_by, OLD.recorded_at)
    OR NEW.version <> OLD.version + 1
    OR (OLD.incident_id IS NOT NULL AND NEW.incident_id IS DISTINCT FROM OLD.incident_id) THEN
    RAISE EXCEPTION 'A treatment is fixed; it can be linked to an incident once or voided'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'voided' THEN
    IF NEW.voided_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A treatment is voided by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.voided_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER first_aid_treatment_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "first_aid_treatments" FOR EACH ROW EXECUTE FUNCTION app.guard_first_aid_treatment();

-- Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['safety_settings', 'safety_inductions', 'toolbox_talks',
    'toolbox_talk_attendees', 'ppe_issues', 'safety_incidents', 'safety_incident_people',
    'safety_incident_photos', 'corrective_actions', 'first_aid_kits', 'first_aid_kit_checks',
    'first_aiders', 'first_aid_treatments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role never deletes safety records (it only removes a draft talk's attendee or an
-- open incident's listed person) and never rewrites kit checks, attendees, people or photos.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE ON "toolbox_talk_attendees", "safety_incident_people", "safety_incident_photos",
      "first_aid_kit_checks" FROM pmb_app;
    REVOKE DELETE ON "safety_settings", "safety_inductions", "toolbox_talks", "ppe_issues",
      "safety_incidents", "safety_incident_photos", "corrective_actions", "first_aid_kits",
      "first_aid_kit_checks", "first_aiders", "first_aid_treatments" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "safety_settings", "safety_inductions", "toolbox_talks", "toolbox_talk_attendees",
         "ppe_issues", "safety_incidents", "safety_incident_people", "safety_incident_photos",
         "corrective_actions", "first_aid_kits", "first_aid_kit_checks", "first_aiders",
         "first_aid_treatments"
      FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.assert_safety_writable(uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.labourer_on_project(uuid, uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.valid_induction_topics(jsonb) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.valid_ppe_replacement_days(jsonb) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.incident_action_counts(uuid, uuid) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.assert_safety_writable(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.labourer_on_project(uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.incident_action_counts(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_safety_settings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_safety_induction() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_toolbox_talk() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_toolbox_talk_attendee() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_ppe_issue() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_safety_incident() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_safety_incident_person() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_incident_people() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_safety_incident_photo() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_corrective_action() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_first_aid_kit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_first_aid_kit_check() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_first_aider() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_first_aid_treatment() FROM PUBLIC;

COMMIT;
