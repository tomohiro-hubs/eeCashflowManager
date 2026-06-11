PRAGMA foreign_keys = ON;

-- Index for periodic cleanup of expired sessions.
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
ON sessions(expires_at);

-- Composite index for user-scoped session maintenance with expiry predicate.
CREATE INDEX IF NOT EXISTS idx_sessions_user_expires_at
ON sessions(user_id, expires_at);
