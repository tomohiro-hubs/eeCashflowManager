ALTER TABLE cashflow_entries ADD COLUMN created_by_user_id INTEGER;

-- 既存データは現在の所有者(user_id)で補完
UPDATE cashflow_entries
SET created_by_user_id = user_id
WHERE created_by_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_entries_created_by_user
ON cashflow_entries(created_by_user_id, scheduled_date, id);
