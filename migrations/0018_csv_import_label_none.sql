PRAGMA foreign_keys = ON;

-- CSV取り込み由来データのラベル色を「なし(空文字)」へ統一
UPDATE cashflow_entries
SET label_color = ''
WHERE import_source_file_name IS NOT NULL
  AND label_color IN ('blue', 'orange');
