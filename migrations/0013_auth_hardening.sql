ALTER TABLE users ADD COLUMN password_algo TEXT NOT NULL DEFAULT 'sha256_iter120k';

CREATE TABLE IF NOT EXISTS login_rate_limits (
  key TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_rate_limits_blocked_until
ON login_rate_limits(blocked_until);
