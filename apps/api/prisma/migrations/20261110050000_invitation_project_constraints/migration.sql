-- Replace invitation project UUID arrays with relational, composite tenant foreign keys.
-- Existing valid invitations are preserved; inconsistent data fails the migration explicitly.
BEGIN;
CREATE UNIQUE INDEX invitations_tenant_id_id_key ON invitations(tenant_id, id);
CREATE TABLE invitation_projects (
  tenant_id uuid NOT NULL,
  invitation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  CONSTRAINT invitation_projects_pkey PRIMARY KEY (tenant_id, invitation_id, project_id),
  CONSTRAINT invitation_projects_tenant_id_invitation_id_fkey FOREIGN KEY (tenant_id, invitation_id)
    REFERENCES invitations(tenant_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT invitation_projects_tenant_id_project_id_fkey FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX invitation_projects_tenant_id_project_id_idx ON invitation_projects(tenant_id, project_id);
-- The schema owner is subject to FORCE ROW LEVEL SECURITY and runs without a tenant context, so
-- it would read no invitations. Lift FORCE for the copy (the lock blocks other sessions), check
-- every project reference was copied, then restore it.
ALTER TABLE invitations NO FORCE ROW LEVEL SECURITY;
INSERT INTO invitation_projects(tenant_id, invitation_id, project_id)
  SELECT tenant_id, id, unnest(project_ids) FROM invitations;
DO $$
BEGIN
  IF (SELECT count(*) FROM invitation_projects)
     <> (SELECT coalesce(sum(cardinality(project_ids)), 0) FROM invitations) THEN
    RAISE EXCEPTION 'invitation project scopes were not all copied';
  END IF;
END $$;
ALTER TABLE invitations DROP COLUMN project_ids;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

ALTER TABLE invitation_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_projects_isolation ON invitation_projects
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
COMMIT;
