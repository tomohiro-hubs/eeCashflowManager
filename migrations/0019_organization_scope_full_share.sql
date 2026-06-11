PRAGMA foreign_keys = ON;

-- Full-share migration baseline:
-- Keep existing user_id-based ownership for backward compatibility,
-- and introduce organization scope in parallel.

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'editor', 'viewer', 'member')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user_org
ON organization_members(user_id, organization_id);

-- Add organization_id columns (nullable for SQLite/D1 compatibility).
ALTER TABLE users ADD COLUMN organization_id INTEGER;
ALTER TABLE cashflow_entries ADD COLUMN organization_id INTEGER;

-- Ensure a deterministic default organization exists for full-share rollout.
INSERT INTO organizations (id, name, created_at)
SELECT 1, 'Default Organization', datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM organizations WHERE id = 1
);

-- Backfill all existing users into the default organization.
UPDATE users
SET organization_id = 1
WHERE organization_id IS NULL;

-- Ensure membership rows exist for all users in their organization.
INSERT OR IGNORE INTO organization_members (organization_id, user_id, role)
SELECT organization_id, id, 'member'
FROM users
WHERE organization_id IS NOT NULL;

-- Backfill entries to organization scope from owning user mapping.
UPDATE cashflow_entries
SET organization_id = (
  SELECT u.organization_id
  FROM users u
  WHERE u.id = cashflow_entries.user_id
)
WHERE organization_id IS NULL;

-- Safety net if a row still cannot resolve through users mapping.
UPDATE cashflow_entries
SET organization_id = 1
WHERE organization_id IS NULL;

-- Org-scoped indexes aligned with existing API patterns.
CREATE INDEX IF NOT EXISTS idx_entries_org_month_expr_order
ON cashflow_entries(organization_id, substr(scheduled_date, 1, 7), order_index, id);

CREATE INDEX IF NOT EXISTS idx_entries_org_month_expr_type
ON cashflow_entries(organization_id, substr(scheduled_date, 1, 7), type);

CREATE INDEX IF NOT EXISTS idx_entries_active_org_month_order
ON cashflow_entries(organization_id, substr(scheduled_date, 1, 7), order_index, id)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entries_active_org_month_type
ON cashflow_entries(organization_id, substr(scheduled_date, 1, 7), type)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entries_active_org_date_order
ON cashflow_entries(organization_id, scheduled_date, order_index, id)
WHERE deleted_at IS NULL;
