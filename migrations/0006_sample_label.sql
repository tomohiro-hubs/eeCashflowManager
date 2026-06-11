ALTER TABLE cashflow_entries ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0 CHECK(is_sample IN (0,1));

CREATE INDEX IF NOT EXISTS idx_entries_user_sample
ON cashflow_entries(user_id, is_sample, scheduled_date, order_index, id);
