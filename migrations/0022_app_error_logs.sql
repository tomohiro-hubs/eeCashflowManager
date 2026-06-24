PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  user_id INTEGER,
  organization_id INTEGER,
  source TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'error' CHECK(level IN ('error', 'warn')),
  method TEXT,
  path TEXT,
  status_code INTEGER,
  message TEXT NOT NULL,
  error_name TEXT,
  stack TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_app_error_logs_org_created_desc
ON app_error_logs(organization_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_app_error_logs_source_created_desc
ON app_error_logs(source, created_at DESC, id DESC);
