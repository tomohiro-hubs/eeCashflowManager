import { beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

const setupStatements = [
  `CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_algo TEXT NOT NULL DEFAULT 'sha256_iter120k',
    is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'editor', 'viewer', 'member')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(organization_id, user_id),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS cashflow_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    organization_id INTEGER,
    title TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    scheduled_date TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    note TEXT,
    account_name TEXT,
    actual_transaction_date TEXT,
    customer_name TEXT,
    staff_name TEXT,
    label_color TEXT NOT NULL DEFAULT '',
    cf_category TEXT NOT NULL DEFAULT '',
    import_source_file_name TEXT,
    import_management_no TEXT,
    import_batch_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    is_sample INTEGER NOT NULL DEFAULT 0 CHECK(is_sample IN (0,1)),
    is_completed INTEGER NOT NULL DEFAULT 0 CHECK(is_completed IN (0,1)),
    created_by_user_id INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (used_at IS NULL OR used_at >= created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS cashflow_entry_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    organization_id INTEGER,
    action TEXT NOT NULL CHECK(action IN ('INSERT', 'UPDATE', 'DELETE')),
    row_snapshot TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (entry_id) REFERENCES cashflow_entries(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cashflow_entry_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('manual', 'scheduled')),
    snapshot_json TEXT NOT NULL,
    entry_count INTEGER NOT NULL DEFAULT 0,
    created_by_user_id INTEGER,
    restored_at TEXT,
    restored_by_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_user_month_order
   ON cashflow_entries(user_id, scheduled_date, order_index)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_org_month_order
   ON cashflow_entries(organization_id, scheduled_date, order_index)`,
  `CREATE INDEX IF NOT EXISTS idx_org_members_org_user
   ON organization_members(organization_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audits_user_entry_changed_desc
   ON cashflow_entry_audits(user_id, entry_id, changed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cashflow_entry_backups_org_created_desc
   ON cashflow_entry_backups(organization_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_user_sample
   ON cashflow_entries(user_id, is_sample, scheduled_date, order_index, id)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_user_completed
   ON cashflow_entries(user_id, is_completed, scheduled_date, order_index, id)`,
  `CREATE INDEX IF NOT EXISTS idx_prt_token_validity
   ON password_reset_tokens(token_hash, used_at, expires_at)`,
  `CREATE TRIGGER IF NOT EXISTS trg_entries_touch_updated_at
   AFTER UPDATE OF title, amount, type, scheduled_date, order_index, note, deleted_at ON cashflow_entries
   FOR EACH ROW
   WHEN NEW.updated_at = OLD.updated_at
   BEGIN
     UPDATE cashflow_entries
     SET updated_at = datetime('now')
     WHERE id = NEW.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_entries_audit_insert
   AFTER INSERT ON cashflow_entries
   FOR EACH ROW
   BEGIN
     INSERT INTO cashflow_entry_audits (entry_id, user_id, organization_id, action, row_snapshot)
     VALUES (
       NEW.id,
       NEW.user_id,
       NEW.organization_id,
       'INSERT',
       json_object(
         'id', NEW.id,
         'user_id', NEW.user_id,
         'organization_id', NEW.organization_id,
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
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_entries_audit_update
   AFTER UPDATE ON cashflow_entries
   FOR EACH ROW
   BEGIN
     INSERT INTO cashflow_entry_audits (entry_id, user_id, organization_id, action, row_snapshot)
     VALUES (
       NEW.id,
       NEW.user_id,
       NEW.organization_id,
       'UPDATE',
       json_object(
         'id', NEW.id,
         'user_id', NEW.user_id,
         'organization_id', NEW.organization_id,
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
   END`,
  `CREATE TABLE IF NOT EXISTS user_session_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_token TEXT NOT NULL,
    login_at TEXT NOT NULL,
    logout_at TEXT,
    logout_reason TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS user_operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    organization_id INTEGER,
    action_type TEXT NOT NULL CHECK(action_type IN ('add', 'edit', 'delete')),
    target_type TEXT NOT NULL,
    target_id INTEGER,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rakuraku_cashflow_import_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    import_batch_id TEXT NOT NULL,
    source_file_name TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    management_no TEXT,
    project_name TEXT,
    expense_total_incl_tax INTEGER,
    income_total_incl_tax INTEGER,
    customer_name TEXT,
    scheduled_date TEXT,
    scheduled_date_raw TEXT,
    row_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_rakuraku_rows_user_file_row
   ON rakuraku_cashflow_import_rows(user_id, source_file_name, row_number)`,
  `CREATE TABLE IF NOT EXISTS rakuraku_cashflow_import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    import_batch_id TEXT NOT NULL,
    source_file_name TEXT NOT NULL,
    source_file_hash TEXT,
    status TEXT NOT NULL,
    total_rows INTEGER NOT NULL DEFAULT 0,
    success_rows INTEGER NOT NULL DEFAULT 0,
    failed_rows INTEGER NOT NULL DEFAULT 0,
    processing_time_ms INTEGER,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_rakuraku_batches_user_batch
   ON rakuraku_cashflow_import_batches(user_id, import_batch_id)`,
  `CREATE TABLE IF NOT EXISTS login_rate_limits (
    key TEXT PRIMARY KEY,
    fail_count INTEGER NOT NULL DEFAULT 0,
    first_failed_at TEXT NOT NULL,
    blocked_until TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS app_error_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT,
    user_id INTEGER,
    organization_id INTEGER,
    source TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'error' CHECK(level IN ('error', 'warn')),
    method TEXT,
    path TEXT,
    status_code INTEGER,
    message TEXT NOT NULL,
    error_name TEXT,
    stack TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
  )`
];

beforeAll(async () => {
  for (const statement of setupStatements) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM user_operation_logs').run();
  await env.DB.prepare('DELETE FROM user_session_logs').run();
  await env.DB.prepare('DELETE FROM login_rate_limits').run();
  await env.DB.prepare('DELETE FROM organization_members').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM rakuraku_cashflow_import_rows').run();
  await env.DB.prepare('DELETE FROM rakuraku_cashflow_import_batches').run();
  await env.DB.prepare('DELETE FROM password_reset_tokens').run();
  await env.DB.prepare('DELETE FROM cashflow_entry_backups').run();
  await env.DB.prepare('DELETE FROM cashflow_entry_audits').run();
  await env.DB.prepare('DELETE FROM app_error_logs').run();
  await env.DB.prepare('DELETE FROM cashflow_entries').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare('DELETE FROM organizations').run();
});
