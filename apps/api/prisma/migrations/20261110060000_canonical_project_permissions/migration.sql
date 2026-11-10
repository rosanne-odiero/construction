BEGIN;

-- AccessExclusiveLock prevents concurrent readers/writers while the schema owner maps
-- all tenant rows. Runtime RLS remains enabled; only the owner temporarily bypasses FORCE.
ALTER TABLE project_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE project_memberships DROP CONSTRAINT project_permissions_check;
UPDATE project_memberships SET permissions = ARRAY(
  SELECT DISTINCT CASE permission
    WHEN 'project.read' THEN 'projects.view'
    WHEN 'project.update' THEN 'projects.manage'
    ELSE permission END
  FROM unnest(permissions) AS permission
  ORDER BY 1
);
ALTER TABLE project_memberships ADD CONSTRAINT project_permissions_check CHECK (
  permissions <@ ARRAY['projects.view','projects.manage']::text[]
);
ALTER TABLE project_memberships FORCE ROW LEVEL SECURITY;

COMMIT;
