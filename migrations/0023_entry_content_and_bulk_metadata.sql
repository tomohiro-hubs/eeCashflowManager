PRAGMA foreign_keys = ON;

ALTER TABLE cashflow_entries ADD COLUMN content TEXT;

DROP TRIGGER IF EXISTS trg_entries_touch_updated_at;
DROP TRIGGER IF EXISTS trg_entries_audit_insert;
DROP TRIGGER IF EXISTS trg_entries_audit_update;
DROP TRIGGER IF EXISTS trg_entries_audit_delete;

CREATE TRIGGER IF NOT EXISTS trg_entries_touch_updated_at
AFTER UPDATE OF title, content, amount, type, scheduled_date, order_index, note, deleted_at, account_name, actual_transaction_date, customer_name, staff_name, label_color, import_source_file_name, import_management_no, import_batch_id, created_by_user_id, organization_id, is_sample, is_completed, cf_category ON cashflow_entries
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE cashflow_entries
  SET updated_at = datetime('now')
  WHERE id = NEW.id;
END;

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
      'organization_id', NEW.organization_id,
      'title', NEW.title,
      'content', NEW.content,
      'amount', NEW.amount,
      'type', NEW.type,
      'scheduled_date', NEW.scheduled_date,
      'order_index', NEW.order_index,
      'note', NEW.note,
      'account_name', NEW.account_name,
      'actual_transaction_date', NEW.actual_transaction_date,
      'customer_name', NEW.customer_name,
      'staff_name', NEW.staff_name,
      'label_color', NEW.label_color,
      'cf_category', NEW.cf_category,
      'import_source_file_name', NEW.import_source_file_name,
      'import_management_no', NEW.import_management_no,
      'import_batch_id', NEW.import_batch_id,
      'is_sample', NEW.is_sample,
      'is_completed', NEW.is_completed,
      'created_by_user_id', NEW.created_by_user_id,
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
      'organization_id', NEW.organization_id,
      'title', NEW.title,
      'content', NEW.content,
      'amount', NEW.amount,
      'type', NEW.type,
      'scheduled_date', NEW.scheduled_date,
      'order_index', NEW.order_index,
      'note', NEW.note,
      'account_name', NEW.account_name,
      'actual_transaction_date', NEW.actual_transaction_date,
      'customer_name', NEW.customer_name,
      'staff_name', NEW.staff_name,
      'label_color', NEW.label_color,
      'cf_category', NEW.cf_category,
      'import_source_file_name', NEW.import_source_file_name,
      'import_management_no', NEW.import_management_no,
      'import_batch_id', NEW.import_batch_id,
      'is_sample', NEW.is_sample,
      'is_completed', NEW.is_completed,
      'created_by_user_id', NEW.created_by_user_id,
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
      'organization_id', OLD.organization_id,
      'title', OLD.title,
      'content', OLD.content,
      'amount', OLD.amount,
      'type', OLD.type,
      'scheduled_date', OLD.scheduled_date,
      'order_index', OLD.order_index,
      'note', OLD.note,
      'account_name', OLD.account_name,
      'actual_transaction_date', OLD.actual_transaction_date,
      'customer_name', OLD.customer_name,
      'staff_name', OLD.staff_name,
      'label_color', OLD.label_color,
      'cf_category', OLD.cf_category,
      'import_source_file_name', OLD.import_source_file_name,
      'import_management_no', OLD.import_management_no,
      'import_batch_id', OLD.import_batch_id,
      'is_sample', OLD.is_sample,
      'is_completed', OLD.is_completed,
      'created_by_user_id', OLD.created_by_user_id,
      'created_at', OLD.created_at,
      'updated_at', OLD.updated_at,
      'deleted_at', OLD.deleted_at
    )
  );
END;
