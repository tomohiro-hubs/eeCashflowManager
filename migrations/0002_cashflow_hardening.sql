PRAGMA foreign_keys = ON;

-- 1) Soft-delete readiness: keep existing behavior (NULL means active).
ALTER TABLE cashflow_entries ADD COLUMN deleted_at TEXT;

-- 2) Audit trail for insert/update/delete on cashflow_entries.
CREATE TABLE IF NOT EXISTS cashflow_entry_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('INSERT', 'UPDATE', 'DELETE')),
  row_snapshot TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (entry_id) REFERENCES cashflow_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entry_audits_entry_changed
ON cashflow_entry_audits(entry_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_entry_audits_user_changed
ON cashflow_entry_audits(user_id, changed_at DESC);

-- 3) Month lookup index aligned with app query pattern (substr on scheduled_date).
CREATE INDEX IF NOT EXISTS idx_entries_user_month_expr_order
ON cashflow_entries(user_id, substr(scheduled_date, 1, 7), order_index, id);

CREATE INDEX IF NOT EXISTS idx_entries_user_month_expr_type
ON cashflow_entries(user_id, substr(scheduled_date, 1, 7), type);

-- 4) Ensure updated_at advances even when app code forgets to set it.
CREATE TRIGGER IF NOT EXISTS trg_entries_touch_updated_at
AFTER UPDATE OF title, amount, type, scheduled_date, order_index, note, deleted_at ON cashflow_entries
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE cashflow_entries
  SET updated_at = datetime('now')
  WHERE id = NEW.id;
END;

-- 5) Row-level audit triggers.
CREATE TRIGGER IF NOT EXISTS trg_entries_audit_insert
AFTER INSERT ON cashflow_entries
FOR EACH ROW
BEGIN
  INSERT INTO cashflow_entry_audits (entry_id, user_id, action, row_snapshot)
  VALUES (
    NEW.id,
    NEW.user_id,
    'INSERT',
    json_object(
      'id', NEW.id,
      'user_id', NEW.user_id,
      'title', NEW.title,
      'amount', NEW.amount,
      'type', NEW.type,
      'scheduled_date', NEW.scheduled_date,
      'order_index', NEW.order_index,
      'note', NEW.note,
      'created_at', NEW.created_at,
      'updated_at', NEW.updated_at,
      'deleted_at', NEW.deleted_at
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_audit_update
AFTER UPDATE ON cashflow_entries
FOR EACH ROW
BEGIN
  INSERT INTO cashflow_entry_audits (entry_id, user_id, action, row_snapshot)
  VALUES (
    NEW.id,
    NEW.user_id,
    'UPDATE',
    json_object(
      'id', NEW.id,
      'user_id', NEW.user_id,
      'title', NEW.title,
      'amount', NEW.amount,
      'type', NEW.type,
      'scheduled_date', NEW.scheduled_date,
      'order_index', NEW.order_index,
      'note', NEW.note,
      'created_at', NEW.created_at,
      'updated_at', NEW.updated_at,
      'deleted_at', NEW.deleted_at
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_audit_delete
BEFORE DELETE ON cashflow_entries
FOR EACH ROW
BEGIN
  INSERT INTO cashflow_entry_audits (entry_id, user_id, action, row_snapshot)
  VALUES (
    OLD.id,
    OLD.user_id,
    'DELETE',
    json_object(
      'id', OLD.id,
      'user_id', OLD.user_id,
      'title', OLD.title,
      'amount', OLD.amount,
      'type', OLD.type,
      'scheduled_date', OLD.scheduled_date,
      'order_index', OLD.order_index,
      'note', OLD.note,
      'created_at', OLD.created_at,
      'updated_at', OLD.updated_at,
      'deleted_at', OLD.deleted_at
    )
  );
END;
