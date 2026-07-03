CREATE TABLE IF NOT EXISTS cashflow_entry_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual', 'scheduled')),
  snapshot_json TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER,
  restored_at TEXT,
  restored_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cashflow_entry_backups_org_created_desc
ON cashflow_entry_backups(organization_id, created_at DESC, id DESC);
