PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rakuraku_cashflow_import_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  import_batch_id TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  management_no TEXT,
  project_name TEXT,
  expense_total_incl_tax INTEGER,
  income_total_incl_tax INTEGER,
  customer_name TEXT,
  scheduled_date TEXT,
  scheduled_date_raw TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rakuraku_rows_user_date
ON rakuraku_cashflow_import_rows(user_id, scheduled_date, row_number);

CREATE INDEX IF NOT EXISTS idx_rakuraku_rows_user_batch
ON rakuraku_cashflow_import_rows(user_id, import_batch_id, row_number);
