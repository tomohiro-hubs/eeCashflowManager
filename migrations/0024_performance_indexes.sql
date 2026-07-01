-- Performance optimization indexes for cashflow entries
CREATE INDEX IF NOT EXISTS idx_entries_active_completed_org_date
ON cashflow_entries(organization_id, scheduled_date)
WHERE deleted_at IS NULL AND is_completed = 1;
