PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (used_at IS NULL OR used_at >= created_at)
);

-- Lookup path for reset execution: token hash equality + validity filter.
CREATE INDEX IF NOT EXISTS idx_prt_token_validity
ON password_reset_tokens(token_hash, used_at, expires_at);

-- User-scoped operational queries (recent issuance, audit, cleanup assistance).
CREATE INDEX IF NOT EXISTS idx_prt_user_created
ON password_reset_tokens(user_id, created_at DESC);

-- Cleanup path for expired/consumed tokens.
CREATE INDEX IF NOT EXISTS idx_prt_expiry_usage
ON password_reset_tokens(expires_at, used_at);
