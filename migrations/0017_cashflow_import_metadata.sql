PRAGMA foreign_keys = ON;

ALTER TABLE cashflow_entries ADD COLUMN import_source_file_name TEXT;
ALTER TABLE cashflow_entries ADD COLUMN import_management_no TEXT;
ALTER TABLE cashflow_entries ADD COLUMN import_batch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_entries_user_import_batch
ON cashflow_entries(user_id, import_batch_id, id);

CREATE INDEX IF NOT EXISTS idx_entries_user_import_file
ON cashflow_entries(user_id, import_source_file_name, id);

CREATE INDEX IF NOT EXISTS idx_entries_user_import_no
ON cashflow_entries(user_id, import_management_no, id);

-- Migrate legacy CSV marker note text into dedicated hidden columns.
UPDATE cashflow_entries
SET
  import_source_file_name = CASE
    WHEN note LIKE '[CSV:%|No:%]' THEN substr(note, 6, instr(note, '|No:') - 6)
    ELSE import_source_file_name
  END,
  import_management_no = CASE
    WHEN note LIKE '[CSV:%|No:%]' THEN substr(note, instr(note, '|No:') + 4, length(note) - (instr(note, '|No:') + 4))
    ELSE import_management_no
  END,
  note = CASE
    WHEN note LIKE '[CSV:%|No:%]' THEN NULL
    ELSE note
  END
WHERE note LIKE '[CSV:%|No:%]';
