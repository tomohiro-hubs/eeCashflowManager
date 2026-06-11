PRAGMA foreign_keys = ON;

-- Import row idempotency and faster filtering for large-volume ingest.
ALTER TABLE rakuraku_cashflow_import_rows
  ADD COLUMN row_hash TEXT;

ALTER TABLE rakuraku_cashflow_import_rows
  ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

-- 1) Duplicate-prevention keys
-- Same user + same source file + same line number should not be inserted twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rakuraku_rows_user_file_row
ON rakuraku_cashflow_import_rows(user_id, source_file_name, row_number);

-- Optional stronger idempotency: prevent same normalized row payload from duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rakuraku_rows_user_row_hash
ON rakuraku_cashflow_import_rows(user_id, row_hash)
WHERE row_hash IS NOT NULL;

-- 2) Primary query indexes for ingest/search workloads
CREATE INDEX IF NOT EXISTS idx_rakuraku_rows_user_scheduled_date
ON rakuraku_cashflow_import_rows(user_id, scheduled_date);

CREATE INDEX IF NOT EXISTS idx_rakuraku_rows_user_management_no
ON rakuraku_cashflow_import_rows(user_id, management_no);

CREATE INDEX IF NOT EXISTS idx_rakuraku_rows_user_customer_name
ON rakuraku_cashflow_import_rows(user_id, customer_name);

CREATE INDEX IF NOT EXISTS idx_rakuraku_rows_user_project_name
ON rakuraku_cashflow_import_rows(user_id, project_name);

CREATE INDEX IF NOT EXISTS idx_rakuraku_rows_user_created_at
ON rakuraku_cashflow_import_rows(user_id, created_at);

-- 3) Optional batch-level import lifecycle/metrics table
CREATE TABLE IF NOT EXISTS rakuraku_cashflow_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  import_batch_id TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  source_file_hash TEXT,
  status TEXT NOT NULL DEFAULT 'processing', -- processing | completed | failed
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  processing_time_ms INTEGER,
  total_rows INTEGER NOT NULL DEFAULT 0,
  success_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (status IN ('processing', 'completed', 'failed')),
  CHECK (processing_time_ms IS NULL OR processing_time_ms >= 0),
  CHECK (total_rows >= 0),
  CHECK (success_rows >= 0),
  CHECK (failed_rows >= 0),
  CHECK (success_rows + failed_rows <= total_rows)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rakuraku_batches_user_batch
ON rakuraku_cashflow_import_batches(user_id, import_batch_id);

CREATE INDEX IF NOT EXISTS idx_rakuraku_batches_user_status_created
ON rakuraku_cashflow_import_batches(user_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_rakuraku_batches_user_source_file
ON rakuraku_cashflow_import_batches(user_id, source_file_name);
