PRAGMA foreign_keys = ON;

-- Partial indexes for future soft-delete queries (WHERE deleted_at IS NULL).
-- Optimizes active-row monthly listing (ORDER BY order_index, id).
CREATE INDEX IF NOT EXISTS idx_entries_active_user_month_order
ON cashflow_entries(user_id, substr(scheduled_date, 1, 7), order_index, id)
WHERE deleted_at IS NULL;

-- Optimizes active-row monthly summary by type (income/expense aggregates).
CREATE INDEX IF NOT EXISTS idx_entries_active_user_month_type
ON cashflow_entries(user_id, substr(scheduled_date, 1, 7), type)
WHERE deleted_at IS NULL;

-- Optimizes active-row date range lookups within a month/user.
CREATE INDEX IF NOT EXISTS idx_entries_active_user_date_order
ON cashflow_entries(user_id, scheduled_date, order_index, id)
WHERE deleted_at IS NULL;
