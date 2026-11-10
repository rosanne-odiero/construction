-- Team administration remains an owner-level capability. Only permissions actually
-- implemented by the Phase 1 project policy may be assigned.
ALTER TABLE project_memberships DROP CONSTRAINT project_permissions_check;
ALTER TABLE project_memberships ADD CONSTRAINT project_permissions_check CHECK (
  permissions <@ ARRAY['project.read','project.update']::text[]
);
