ALTER TABLE cashflow_entries ADD COLUMN is_completed INTEGER NOT NULL DEFAULT 0 CHECK(is_completed IN (0,1));
CREATE INDEX IF NOT EXISTS idx_entries_user_completed ON cashflow_entries(user_id, is_completed, scheduled_date, order_index, id);
