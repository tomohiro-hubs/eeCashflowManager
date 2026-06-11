CREATE TABLE IF NOT EXISTS user_session_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_token TEXT NOT NULL,
  login_at TEXT NOT NULL DEFAULT (datetime('now')),
  logout_at TEXT,
  logout_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_logs_user_login
ON user_session_logs(user_id, login_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_logs_token
ON user_session_logs(session_token);

CREATE TABLE IF NOT EXISTS user_operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('add','edit','delete')),
  target_type TEXT NOT NULL,
  target_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_user_time
ON user_operation_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operation_logs_target
ON user_operation_logs(target_type, target_id, created_at DESC);
