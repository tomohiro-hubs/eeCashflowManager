PRAGMA foreign_keys = ON;

-- Practical read indexes for audit investigation workflows.
-- 1) User-scoped timeline (latest first), optional narrowing by entry_id.
CREATE INDEX IF NOT EXISTS idx_audits_user_entry_changed_desc
ON cashflow_entry_audits(user_id, entry_id, changed_at DESC);

-- 2) Entry history timeline (latest first), with stable tiebreaker.
CREATE INDEX IF NOT EXISTS idx_audits_entry_changed_desc_id_desc
ON cashflow_entry_audits(entry_id, changed_at DESC, id DESC);

-- 3) Global/user timeline scans by date range (latest first).
CREATE INDEX IF NOT EXISTS idx_audits_user_changed_desc_id_desc
ON cashflow_entry_audits(user_id, changed_at DESC, id DESC);
