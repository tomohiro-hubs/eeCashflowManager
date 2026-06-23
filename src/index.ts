import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { CASHFLOW_STATEMENT_COLUMNS, CASHFLOW_STATEMENT_ROWS } from './cashflowStatementData';

type Env = {
  DB: D1Database;
};

type User = { id: number; email: string; isAdmin: boolean; organizationId: number | null };
type CashflowEntryBackupSource = 'manual' | 'scheduled';
type CashflowEntryBackupListRow = {
  id: number;
  organization_id: number;
  source: CashflowEntryBackupSource;
  entry_count: number;
  created_at: string;
  created_by_email: string | null;
  restored_at: string | null;
  restored_by_email: string | null;
};

const CASHFLOW_BACKUP_RETENTION_DAYS = 7;

const app = new Hono<{ Bindings: Env; Variables: { user: User | null } }>();
const SESSION_COOKIE = 'cf_cashflow_session';
const SESSION_TTL_DAYS = 14;
const SESSION_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MINUTES = 30;
const MAX_TITLE_LENGTH = 120;
const MAX_NOTE_LENGTH = 500;
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 1_000_000_000;
const PASSWORD_RESET_TTL_MINUTES = 30;
const PASSWORD_ALGO_PBKDF2 = 'pbkdf2_sha256_310000';
const PASSWORD_ALGO_LEGACY = 'sha256_iter120k';
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const ENTRY_LABEL_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
const CF_CATEGORIES = [
  '',
  '現金売上',
  '売掛金回収',
  '未収入金・前受金入金',
  'その他の収入',
  '売電収入（西予発電所）',
  '売電収入（府中発電所）',
  '売電収入（茨城発電所）',
  '現金仕入',
  '買掛金支払',
  '未払金・前渡金支払',
  '人件費支出',
  '家賃等',
  '固定費',
  '租税公課',
  'その他の支出（社長）',
  'その他の支出（UFJ）',
  'その他の支出（木下）',
  'その他の支出（その他）',
  '固定性預金払戻し',
  '銀行借入',
  'E借入',
  '売電事業分資金移動',
  '設備収入（設備売却など）',
  'その他の財務等収入',
  '銀行借入返済',
  '設備支出（固定資産投資）',
  'その他の財務等支出',
  '利息保証料支払',
  'リース債務返済'
] as const;
const CF_INCOME_CATEGORIES = [
  '現金売上',
  '売掛金回収',
  '未収入金・前受金入金',
  'その他の収入',
  '売電収入（西予発電所）',
  '売電収入（府中発電所）',
  '売電収入（茨城発電所）',
  '固定性預金払戻し',
  '銀行借入',
  'E借入',
  '売電事業分資金移動',
  '設備収入（設備売却など）',
  'その他の財務等収入'
] as const;
const CF_EXPENSE_CATEGORIES = [
  '現金仕入',
  '買掛金支払',
  '未払金・前渡金支払',
  '人件費支出',
  '家賃等',
  '固定費',
  '租税公課',
  'その他の支出（社長）',
  'その他の支出（UFJ）',
  'その他の支出（木下）',
  'その他の支出（その他）',
  '銀行借入返済',
  '設備支出（固定資産投資）',
  'その他の財務等支出',
  '利息保証料支払',
  'リース債務返済'
] as const;
const CASHFLOW_STATEMENT_OPERATING_INCOME_CATEGORIES = new Set([
  '現金売上',
  '売掛金回収',
  '未収入金・前受金入金',
  'その他の収入',
  '売電収入（西予発電所）',
  '売電収入（府中発電所）',
  '売電収入（茨城発電所）'
]);
const CASHFLOW_STATEMENT_OPERATING_EXPENSE_CATEGORIES = new Set([
  '現金仕入',
  '買掛金支払',
  '未払金・前渡金支払',
  '人件費支出',
  '家賃等',
  '固定費',
  '租税公課',
  'その他の支出（社長）',
  'その他の支出（UFJ）',
  'その他の支出（木下）',
  'その他の支出（その他）'
]);
const CASHFLOW_STATEMENT_FINANCING_INCOME_CATEGORIES = new Set([
  '固定性預金払戻し',
  '銀行借入',
  'E借入',
  '売電事業分資金移動',
  '設備収入（設備売却など）',
  'その他の財務等収入'
]);
const CASHFLOW_STATEMENT_FINANCING_EXPENSE_CATEGORIES = new Set([
  '銀行借入返済',
  '設備支出（固定資産投資）',
  'その他の財務等支出',
  '利息保証料支払',
  'リース債務返済'
]);
function getCfCategoriesByEntryType(type: string): readonly string[] {
  return type === 'expense' ? CF_EXPENSE_CATEGORIES : CF_INCOME_CATEGORIES;
}

const CSRF_EXEMPT_PATHS = new Set(['/login', '/register', '/forgot-password', '/reset-password']);
const CSV_IMPORT_ERROR_CODES = {
  unsupportedContentType: 'CSV_IMPORT_UNSUPPORTED_CONTENT_TYPE',
  multipartParseFailed: 'CSV_IMPORT_MULTIPART_PARSE_FAILED',
  fileMissing: 'CSV_IMPORT_FILE_MISSING',
  fileDecodeFailed: 'CSV_IMPORT_FILE_DECODE_FAILED',
  csvEmpty: 'CSV_IMPORT_EMPTY_FILE',
  csvHeaderMismatch: 'CSV_IMPORT_HEADER_MISMATCH',
  invalidJson: 'CSV_IMPORT_INVALID_JSON_BODY',
  noImportableRows: 'CSV_IMPORT_NO_IMPORTABLE_ROWS',
  queryBindLimitExceeded: 'CSV_IMPORT_QUERY_BIND_LIMIT_EXCEEDED',
  rowDbWriteFailed: 'CSV_IMPORT_ROW_DB_WRITE_FAILED',
  internalError: 'CSV_IMPORT_INTERNAL_ERROR'
} as const;
type CsvImportErrorCode = (typeof CSV_IMPORT_ERROR_CODES)[keyof typeof CSV_IMPORT_ERROR_CODES];

function requireOrganizationContext(c: Context): { user: User; organizationId: number } | Response {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!Number.isInteger(user.organizationId) || Number(user.organizationId) <= 0) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return { user, organizationId: Number(user.organizationId) };
}

class CsvImportParseError extends Error {
  code: CsvImportErrorCode;
  constructor(code: CsvImportErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

app.use('*', async (c, next) => {
  await next();
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  c.header('Content-Security-Policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
});

app.use('*', async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    c.set('user', null);
    return next();
  }

  const nowIso = new Date().toISOString();
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.is_admin, u.organization_id, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  )
    .bind(token, nowIso)
    .first<{ id: number; email: string; is_admin: number; organization_id: number | null; expires_at: string }>();

  c.set('user', row ? { id: row.id, email: row.email, isAdmin: Number(row.is_admin) === 1, organizationId: row.organization_id } : null);

  // Sliding expiration: extend only when session is close enough to expiry.
  if (row) {
    const nowMs = Date.now();
    const expiresMs = Date.parse(row.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs - nowMs <= SESSION_REFRESH_WINDOW_MS) {
      const nextExpires = new Date(nowMs + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').bind(nextExpires, token).run();
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/',
        expires: new Date(nextExpires)
      });
    }
  }

  await next();
});

app.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();
  if (CSRF_EXEMPT_PATHS.has(c.req.path)) return next();

  const origin = c.req.header('Origin');
  const host = c.req.header('Host');
  const secFetchSite = c.req.header('Sec-Fetch-Site');

  // Allow same-origin navigations and same-site fetches; block cross-site mutating requests.
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return c.json({ error: 'CSRF validation failed' }, 403);
      }
    } catch {
      return c.json({ error: 'CSRF validation failed' }, 403);
    }
  }

  if (secFetchSite === 'cross-site') {
    return c.json({ error: 'CSRF validation failed' }, 403);
  }

  await next();
});

app.get('/', (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login');
  return c.redirect('/app');
});

app.get('/login', (c) => c.html(renderAuthPage('login')));
app.get('/login/', (c) => c.redirect('/login'));
app.get('/register', (c) => c.redirect('/login'));

app.post('/register', async (c) => {
  return c.html(renderAuthPage('login', '新規アカウント作成は現在停止しています。'), 403);
});

app.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const email = normalizeEmail(String(form.email ?? ''));
  const password = String(form.password ?? '');
  const clientIp = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
  const loginRateLimitKey = `${clientIp}|${email}`;

  const blockedUntil = await getLoginBlockedUntil(c.env.DB, loginRateLimitKey);
  if (blockedUntil && Date.parse(blockedUntil) > Date.now()) {
    return c.html(renderAuthPage('login', '試行回数が上限に達しました。しばらく待ってから再試行してください。'), 429);
  }

  const user = await c.env.DB.prepare('SELECT id, password_hash, password_salt, password_algo FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; password_hash: string; password_salt: string; password_algo: string | null }>();

  if (!user) {
    await recordLoginFailure(c.env.DB, loginRateLimitKey);
    return c.html(renderAuthPage('login', 'メールアドレスまたはパスワードが違います。'), 401);
  }

  const isValidPassword = await verifyPassword(password, user.password_salt, user.password_hash, user.password_algo);
  if (!isValidPassword) {
    await recordLoginFailure(c.env.DB, loginRateLimitKey);
    return c.html(renderAuthPage('login', 'メールアドレスまたはパスワードが違います。'), 401);
  }

  await clearLoginFailures(c.env.DB, loginRateLimitKey);

  const currentAlgo = (user.password_algo ?? PASSWORD_ALGO_LEGACY).trim();
  if (currentAlgo !== PASSWORD_ALGO_PBKDF2) {
    try {
      const nextSalt = randomToken(16);
      const nextHash = await hashPasswordPbkdf2(password, nextSalt);
      await c.env.DB.prepare(
        `UPDATE users
         SET password_hash = ?, password_salt = ?, password_algo = ?
         WHERE id = ?`
      ).bind(nextHash, nextSalt, PASSWORD_ALGO_PBKDF2, user.id).run();
    } catch (rehashError) {
      console.error('password rehash migration skipped', rehashError);
    }
  }

  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await c.env.DB.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)')
    .bind(user.id, token, expires)
    .run();
  await c.env.DB.prepare(
    'INSERT INTO user_session_logs (user_id, session_token, login_at) VALUES (?, ?, datetime(\'now\'))'
  ).bind(user.id, token).run();

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    expires: new Date(expires)
  });

  return c.redirect('/app');
});

app.onError((err, c) => {
  const requestId = crypto.randomUUID();
  console.error(`[${requestId}] ${c.req.method} ${c.req.path}`, err);
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Internal Server Error', requestId }, 500);
  }
  return c.text(`Internal Server Error (requestId: ${requestId})`, 500);
});

app.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = c.get('user');
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    if (user) {
      await c.env.DB.prepare(
        `UPDATE user_session_logs
         SET logout_at = datetime('now'), logout_reason = 'user_logout'
         WHERE user_id = ? AND session_token = ? AND logout_at IS NULL`
      ).bind(user.id, token).run();
    }
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/login');
});

app.post('/api/auth/forgot-password', async (c) => {
  return c.json({ error: 'Password reset is disabled' }, 403);
});

app.post('/api/auth/reset-password', async (c) => {
  return c.json({ error: 'Password reset is disabled' }, 403);
});

app.post('/forgot-password', async (c) => {
  return c.html(renderAuthPage('login', 'パスワード再設定は現在停止しています。'), 403);
});

app.post('/reset-password', async (c) => {
  return c.html(renderAuthPage('login', 'パスワード再設定は現在停止しています。'), 403);
});

app.get('/app', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login');
  return c.html(renderAppPage(user.email, user.isAdmin));
});

app.get('/fiscal', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login');
  return c.html(renderFiscalPage(user.email, user.isAdmin));
});

app.get('/cashflow-statement', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login');
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const cashflowStatementData = await loadCashflowStatementData(c.env.DB, auth.organizationId, 2026, 2031);
  return c.html(renderCashflowStatementPage(user.email, user.isAdmin, cashflowStatementData));
});

app.get('/audit', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login');
  if (!user.isAdmin) return c.text('Forbidden', 403);
  return c.html(renderAuditPage(user.email));
});

app.get('/admin/backups', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  if (!user.isAdmin) return c.text('Forbidden', 403);

  const backups = await listCashflowEntryBackups(c.env.DB, organizationId);
  const status = String(c.req.query('status') ?? '').trim();
  return c.html(renderBackupsPage(user.email, backups, status));
});

app.post('/admin/backups/run', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  if (!user.isAdmin) return c.text('Forbidden', 403);

  try {
    const backup = await createCashflowEntryBackup(c.env.DB, organizationId, user.id, 'manual');
    await pruneCashflowEntryBackups(c.env.DB);
    if (backup) {
      await c.env.DB.prepare(
        `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
         VALUES (?, 'add', 'cashflow_entry_backup', ?)`
      ).bind(user.id, JSON.stringify({ organizationId, source: 'manual' })).run();
    }
    return c.redirect(`/admin/backups?status=${backup ? 'created' : 'empty'}`);
  } catch (error) {
    console.error('cashflow backup create failed', { userId: user.id, organizationId, error });
    return c.html(renderBackupsPage(user.email, await listCashflowEntryBackups(c.env.DB, organizationId), 'バックアップ作成に失敗しました。'), 500);
  }
});

app.post('/admin/backups/:id/restore', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  if (!user.isAdmin) return c.text('Forbidden', 403);

  const backupId = Number(c.req.param('id'));
  if (!Number.isInteger(backupId) || backupId <= 0) {
    return c.text('Invalid backup id', 400);
  }

  try {
    const restoredCount = await restoreCashflowEntryBackup(c.env.DB, backupId, organizationId, user.id);
    await pruneCashflowEntryBackups(c.env.DB);
    await c.env.DB.prepare(
      `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
       VALUES (?, 'edit', 'cashflow_entry_backup_restore', ?)`
    ).bind(user.id, JSON.stringify({ backupId, organizationId, restoredCount })).run();
    return c.redirect('/admin/backups?status=restored');
  } catch (error) {
    console.error('cashflow backup restore failed', { userId: user.id, organizationId, backupId, error });
    return c.html(renderBackupsPage(user.email, await listCashflowEntryBackups(c.env.DB, organizationId), 'バックアップ復元に失敗しました。'), 500);
  }
});

app.get('/password-change', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login');
  return c.html(renderPasswordChangePage(user.email));
});

app.post('/password-change', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login');
  const form = await c.req.parseBody();
  const currentPassword = String(form.currentPassword ?? '');
  const newPassword = String(form.newPassword ?? '');
  const newPasswordConfirm = String(form.newPasswordConfirm ?? '');

  if (!currentPassword || !newPassword || !newPasswordConfirm) {
    return c.html(renderPasswordChangePage(user.email, 'すべての項目を入力してください。'), 400);
  }
  if (newPassword !== newPasswordConfirm) {
    return c.html(renderPasswordChangePage(user.email, '新しいパスワードが一致しません。'), 400);
  }
  if (!isStrongPassword(newPassword)) {
    return c.html(renderPasswordChangePage(user.email, '新しいパスワードが要件を満たしていません。'), 400);
  }

  const dbUser = await c.env.DB.prepare(
    'SELECT password_hash, password_salt, password_algo FROM users WHERE id = ?'
  ).bind(user.id).first<{ password_hash: string; password_salt: string; password_algo: string | null }>();
  if (!dbUser) return c.redirect('/login');

  const isValid = await verifyPassword(currentPassword, dbUser.password_salt, dbUser.password_hash, dbUser.password_algo);
  if (!isValid) {
    return c.html(renderPasswordChangePage(user.email, '現在のパスワードが違います。'), 401);
  }

  const nextSalt = randomToken(16);
  const nextHash = await hashPasswordPbkdf2(newPassword, nextSalt);
  await c.env.DB.prepare(
    `UPDATE users
     SET password_hash = ?, password_salt = ?, password_algo = ?
     WHERE id = ?`
  ).bind(nextHash, nextSalt, PASSWORD_ALGO_PBKDF2, user.id).run();

  return c.html(renderPasswordChangePage(user.email, 'パスワードを更新しました。', true));
});

app.get('/api/summary', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { organizationId } = auth;
  const month = parseMonth(c.req.query('month'));
  if (!month) return c.json({ error: 'Invalid month. Use YYYY-MM.' }, 400);

  const row = await c.env.DB.prepare(
    `SELECT
     COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
     FROM cashflow_entries
     WHERE organization_id = ? AND substr(scheduled_date, 1, 7) = ? AND deleted_at IS NULL`
  )
    .bind(organizationId, month)
    .first<{ income: number; expense: number }>();

  const income = Number(row?.income ?? 0);
  const expense = Number(row?.expense ?? 0);
  return c.json({ month, income, expense, balance: income - expense });
});

app.get('/api/annual-expense-entries', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { organizationId } = auth;
  const year = parseYear(c.req.query('year'));
  if (!year) return c.json({ error: 'Invalid year. Use YYYY.' }, 400);

  const result = await c.env.DB.prepare(
    `SELECT id, scheduled_date, title, amount, note, type
     FROM cashflow_entries
     WHERE organization_id = ? AND deleted_at IS NULL AND is_completed = 1 AND substr(scheduled_date, 1, 4) = ?
     ORDER BY scheduled_date ASC, order_index ASC, id ASC`
  )
    .bind(organizationId, year)
    .all<{ id: number; scheduled_date: string; title: string; amount: number; note: string | null; type: 'income' | 'expense' }>();

  return c.json({ year, entries: result.results ?? [] });
});

app.get('/api/fiscal-range', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { organizationId } = auth;
  const startMonth = parseMonth(c.req.query('startMonth'));
  const endMonth = parseMonth(c.req.query('endMonth'));
  if (!startMonth || !endMonth) return c.json({ error: 'Invalid period. Use YYYY-MM.' }, 400);
  if (startMonth > endMonth) return c.json({ error: 'Invalid period order.' }, 400);

  const monthRows = await c.env.DB.prepare(
    `SELECT
      substr(scheduled_date, 1, 7) as month,
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
    FROM cashflow_entries
    WHERE organization_id = ?
      AND deleted_at IS NULL
      AND substr(scheduled_date, 1, 7) >= ?
      AND substr(scheduled_date, 1, 7) <= ?
    GROUP BY substr(scheduled_date, 1, 7)
    ORDER BY month ASC`
  )
    .bind(organizationId, startMonth, endMonth)
    .all<{ month: string; income: number; expense: number }>();

  const expenseRows = await c.env.DB.prepare(
    `SELECT title, COALESCE(SUM(amount), 0) as amount
    FROM cashflow_entries
    WHERE organization_id = ?
      AND deleted_at IS NULL
      AND type = 'expense'
      AND substr(scheduled_date, 1, 7) >= ?
      AND substr(scheduled_date, 1, 7) <= ?
    GROUP BY title
    ORDER BY amount DESC
    LIMIT 8`
  )
    .bind(organizationId, startMonth, endMonth)
    .all<{ title: string; amount: number }>();

  return c.json({ months: monthRows.results ?? [], expenseBreakdown: expenseRows.results ?? [] });
});

app.get('/api/fiscal-summary', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { organizationId } = auth;

  const start = parseMonth(c.req.query('start'));
  const end = parseMonth(c.req.query('end'));
  if (!start || !end) return c.json({ error: 'Invalid period. Use start/end as YYYY-MM.' }, 400);
  if (start > end) return c.json({ error: 'Invalid period order. start must be <= end.' }, 400);

  const months = enumerateMonths(start, end);
  if (months.length < 1 || months.length > 120) {
    return c.json({ error: 'Invalid period length. Use 1..120 months.' }, 400);
  }

  const monthlyResult = await c.env.DB.prepare(
    `SELECT
      substr(scheduled_date, 1, 7) as month,
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
     FROM cashflow_entries
     WHERE organization_id = ?
       AND deleted_at IS NULL
       AND substr(scheduled_date, 1, 7) >= ?
       AND substr(scheduled_date, 1, 7) <= ?
     GROUP BY substr(scheduled_date, 1, 7)
     ORDER BY month ASC`
  )
    .bind(organizationId, start, end)
    .all<{ month: string; income: number; expense: number }>();

  const monthlyMap = new Map((monthlyResult.results ?? []).map((r) => [r.month, r]));
  const monthlyTrend = months.map((month) => {
    const row = monthlyMap.get(month);
    const income = Number(row?.income ?? 0);
    const expense = Number(row?.expense ?? 0);
    return { month, income, expense, balance: income - expense };
  });

  const categoryResult = await c.env.DB.prepare(
    `SELECT
      title,
      COALESCE(SUM(amount), 0) as amount
     FROM cashflow_entries
     WHERE organization_id = ?
       AND deleted_at IS NULL
       AND type = 'expense'
       AND substr(scheduled_date, 1, 7) >= ?
       AND substr(scheduled_date, 1, 7) <= ?
     GROUP BY title
     ORDER BY amount DESC, title ASC`
  )
    .bind(organizationId, start, end)
    .all<{ title: string; amount: number }>();

  const normalizedCategories = (categoryResult.results ?? []).map((row) => ({
    title: String(row.title ?? '').trim() || '未分類',
    amount: Number(row.amount ?? 0)
  }));
  const topLimit = 8;
  const topCategories = normalizedCategories.slice(0, topLimit);
  const othersAmount = normalizedCategories.slice(topLimit).reduce((sum, row) => sum + row.amount, 0);
  const expenseCategoryBreakdown = othersAmount > 0
    ? [...topCategories, { title: 'その他', amount: othersAmount }]
    : topCategories;

  const totalIncome = monthlyTrend.reduce((sum, row) => sum + row.income, 0);
  const totalExpense = monthlyTrend.reduce((sum, row) => sum + row.expense, 0);
  const operatingCF = totalIncome - totalExpense;
  const averageMonthlyBalance = months.length > 0 ? operatingCF / months.length : 0;
  const worstMonth = monthlyTrend.reduce<{ month: string; balance: number } | null>(
    (acc, cur) => (acc === null || cur.balance < acc.balance ? { month: cur.month, balance: cur.balance } : acc),
    null
  );

  return c.json({
    period: { start, end, months: months.length },
    monthlyTrend,
    expenseCategoryBreakdown,
    kpi: {
      totalIncome,
      totalExpense,
      operatingCF,
      averageMonthlyBalance,
      worstMonth: worstMonth ?? { month: start, balance: 0 }
    }
  });
});

app.get('/api/audit/session-logs', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.isAdmin) return c.json({ error: 'Forbidden' }, 403);
  const from = parseDateOnly(c.req.query('from'));
  const to = parseDateOnly(c.req.query('to'));
  const fromUtc = toAuditUtcStart(from);
  const toUtcExclusive = toAuditUtcEndExclusive(to);
  const email = normalizeEmail(String(c.req.query('email') ?? ''));
  if ((c.req.query('from') && !from) || (c.req.query('to') && !to)) {
    return c.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, 400);
  }

  const rows = await c.env.DB.prepare(
    `SELECT l.login_at, l.logout_at, l.logout_reason,
            substr(l.session_token, 1, 10) || '…' || substr(l.session_token, -6) AS session_token_masked,
            u.email as user_email
     FROM user_session_logs l
     JOIN users u ON u.id = l.user_id
     WHERE (? = '' OR lower(u.email) = ?)
       AND (? IS NULL OR login_at >= ?)
       AND (? IS NULL OR login_at < ?)
     ORDER BY l.login_at DESC
     LIMIT 500`
  )
    .bind(email, email, fromUtc, fromUtc, toUtcExclusive, toUtcExclusive)
    .all<{ login_at: string; logout_at: string | null; logout_reason: string | null; session_token_masked: string; user_email: string }>();

  return c.json({ logs: rows.results ?? [] });
});

app.get('/api/audit/operation-logs', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.isAdmin) return c.json({ error: 'Forbidden' }, 403);
  const from = parseDateOnly(c.req.query('from'));
  const to = parseDateOnly(c.req.query('to'));
  const fromUtc = toAuditUtcStart(from);
  const toUtcExclusive = toAuditUtcEndExclusive(to);
  const action = String(c.req.query('action') ?? '').trim();
  const email = normalizeEmail(String(c.req.query('email') ?? ''));
  if ((c.req.query('from') && !from) || (c.req.query('to') && !to)) {
    return c.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, 400);
  }
  if (action && !['add', 'edit', 'delete'].includes(action)) {
    return c.json({ error: 'Invalid action filter' }, 400);
  }

  const rows = await c.env.DB.prepare(
    `SELECT o.action_type, o.target_type, o.target_id, o.detail, o.created_at, u.email as user_email
     FROM user_operation_logs o
     JOIN users u ON u.id = o.user_id
     WHERE (? = '' OR lower(u.email) = ?)
       AND (? = '' OR o.action_type = ?)
       AND (? IS NULL OR o.created_at >= ?)
       AND (? IS NULL OR o.created_at < ?)
     ORDER BY o.created_at DESC
     LIMIT 1000`
  )
    .bind(email, email, action, action, fromUtc, fromUtc, toUtcExclusive, toUtcExclusive)
    .all<{ action_type: 'add' | 'edit' | 'delete'; target_type: string; target_id: number | null; detail: string | null; created_at: string; user_email: string }>();

  return c.json({ logs: rows.results ?? [] });
});

app.get('/api/entries', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { organizationId } = auth;
  const year = parseYear(c.req.query('year'));
  if (!year) return c.json({ error: 'Invalid year. Use YYYY.' }, 400);

  const result = await c.env.DB.prepare(
    `SELECT id, title, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, cf_category, is_sample, is_completed, created_by_user_id, import_management_no
     FROM cashflow_entries
     WHERE organization_id = ? AND substr(scheduled_date, 1, 4) = ? AND deleted_at IS NULL
     ORDER BY scheduled_date ASC, order_index ASC, id ASC`
  )
    .bind(organizationId, year)
    .all();

  return c.json({ year, entries: result.results ?? [] });
});

app.get('/api/opening-balance', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { organizationId } = auth;
  const month = parseMonth(c.req.query('month'));
  if (!month) return c.json({ error: 'Invalid month. Use YYYY-MM.' }, 400);

  const row = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) as opening_balance
     FROM cashflow_entries
     WHERE organization_id = ? AND deleted_at IS NULL AND scheduled_date < ?`
  )
    .bind(organizationId, `${month}-01`)
    .first<{ opening_balance: number }>();

  return c.json({ month, openingBalance: Number(row?.opening_balance ?? 0) });
});

app.get('/api/audits', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { organizationId } = auth;

  const month = parseMonth(c.req.query('month'));
  if (!month) return c.json({ error: 'Invalid month. Use YYYY-MM.' }, 400);
  const limit = parseLimit(c.req.query('limit'));
  if (limit === null) return c.json({ error: 'Invalid limit. Use 1..500.' }, 400);

  const result = await c.env.DB.prepare(
    `SELECT
      a.changed_at,
      a.action,
      a.entry_id,
      json_extract(a.row_snapshot, '$.title') AS title,
      CAST(json_extract(a.row_snapshot, '$.amount') AS INTEGER) AS amount,
      json_extract(a.row_snapshot, '$.type') AS type,
      json_extract(a.row_snapshot, '$.scheduled_date') AS scheduled_date,
      CAST(json_extract(a.row_snapshot, '$.order_index') AS INTEGER) AS order_index
     FROM cashflow_entry_audits a
     JOIN cashflow_entries e ON e.id = a.entry_id
     WHERE e.organization_id = ? AND substr(json_extract(a.row_snapshot, '$.scheduled_date'), 1, 7) = ?
     ORDER BY a.changed_at DESC, a.id DESC
     LIMIT ?`
  )
    .bind(organizationId, month, limit)
    .all<{
      changed_at: string;
      action: 'INSERT' | 'UPDATE' | 'DELETE';
      entry_id: number;
      title: string;
      amount: number;
      type: 'income' | 'expense';
      scheduled_date: string;
      order_index: number;
    }>();

  return c.json({ audits: result.results ?? [] });
});

app.post('/api/entries', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;

  const body = await parseJsonBody<{
    title?: string;
    amount?: number;
    type?: 'income' | 'expense';
    scheduledDate?: string;
    note?: string;
    accountName?: string;
    customerName?: string;
    staffName?: string;
    labelColor?: string;
    cfCategory?: string;
  }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const accountName = typeof body.accountName === 'string' ? body.accountName.trim() : '';
  const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : '';
  const staffName = typeof body.staffName === 'string' ? body.staffName.trim() : '';
  const labelColor = typeof body.labelColor === 'string' ? body.labelColor.trim() : '';
  const cfCategory = typeof body.cfCategory === 'string' ? body.cfCategory.trim() : '';
  const allowedCfCategories = new Set(['', ...getCfCategoriesByEntryType(typeof body.type === 'string' ? body.type : 'income')]);

  const validatedInput = {
    title,
    note,
    amount: body.amount,
    type: body.type,
    scheduledDate: body.scheduledDate,
    accountName,
    customerName,
    staffName,
    labelColor,
    cfCategory
  };
  if (!isValidEntryInput(validatedInput, allowedCfCategories)) {
    return c.json({ error: 'Invalid payload' }, 400);
  }

  const month = validatedInput.scheduledDate.slice(0, 7);
  const maxRow = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(order_index), 0) as max_order
     FROM cashflow_entries
     WHERE organization_id = ? AND substr(scheduled_date, 1, 7) = ? AND deleted_at IS NULL`
  )
    .bind(organizationId, month)
    .first<{ max_order: number }>();

  const order = Number(maxRow?.max_order ?? 0) + 1;

  await c.env.DB.prepare(
    `INSERT INTO cashflow_entries
      (user_id, organization_id, title, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, cf_category, is_sample, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(
      user.id,
      organizationId,
      validatedInput.title,
      validatedInput.amount,
      validatedInput.type,
      validatedInput.scheduledDate,
      order,
      validatedInput.note,
      validatedInput.accountName || null,
      null,
      validatedInput.customerName || null,
      validatedInput.staffName || null,
      validatedInput.labelColor,
      validatedInput.cfCategory,
      user.id
    )
    .run();
  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
     VALUES (?, 'add', 'cashflow_entry', ?)`
  ).bind(user.id, JSON.stringify({
    title: validatedInput.title,
    amount: validatedInput.amount,
    type: validatedInput.type,
    scheduledDate: validatedInput.scheduledDate
  })).run();

  return c.json({ ok: true });
});

app.post('/api/import/rakuraku', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) {
    const status = auth.status === 401 ? 401 : 403;
    const message = status === 401 ? 'Unauthorized' : 'Forbidden';
    const errorCode = status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN';
    return c.json({ ok: false, errorCode, error: message, message }, status);
  }
  const { user, organizationId } = auth;

  try {
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ ok: false, errorCode: CSV_IMPORT_ERROR_CODES.unsupportedContentType, error: 'Content-Type must be multipart/form-data' }, 415);
    }
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch (error) {
      console.error('rakuraku import preview multipart parse failed', { userId: user.id, error });
      return c.json({ ok: false, errorCode: CSV_IMPORT_ERROR_CODES.multipartParseFailed, error: 'multipart/form-data の解析に失敗しました。' }, 400);
    }
    const file = form.file;
    if (!(file instanceof File)) {
      return c.json({ ok: false, errorCode: CSV_IMPORT_ERROR_CODES.fileMissing, error: 'CSVファイルがありません。' }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = decodeShiftJisLike(bytes);
    
    // Parse Rakuraku CSV
    let incomingRows: Array<{
      managementNo?: string;
      projectName?: string;
      expenseTotalInclTax?: number | null;
      incomeTotalInclTax?: number | null;
      customerName?: string;
      scheduledDateRaw?: string;
      scheduledDate?: string;
    }> = [];
    try {
      incomingRows = parseRakurakuCsvText(text);
    } catch (error) {
      console.error('rakuraku import csv parse failed', { userId: user.id, error });
      if (error instanceof CsvImportParseError) {
        return c.json({ ok: false, errorCode: error.code, error: error.message }, 400);
      }
      return c.json({ ok: false, errorCode: CSV_IMPORT_ERROR_CODES.internalError, error: 'CSVファイルの解析に失敗しました。' }, 400);
    }

    const preparedRows: Array<{
      rowNumber: number;
      managementNo: string;
      projectName: string;
      expense: number | null;
      income: number | null;
      customerName: string;
      scheduledDateRaw: string;
      scheduledDate: string;
    }> = [];
    let invalidRows = 0;

    for (let i = 0; i < incomingRows.length; i += 1) {
      const row = incomingRows[i] ?? {};
      const managementNo = String(row.managementNo ?? '').trim();
      const projectName = String(row.projectName ?? '').trim();
      const customerName = String(row.customerName ?? '').trim();
      const scheduledDateRaw = String(row.scheduledDateRaw ?? '').trim();
      const scheduledDate = parseSlashOrIsoDate(String(row.scheduledDate ?? scheduledDateRaw ?? '').trim());
      const expense = parseNullableInt(row.expenseTotalInclTax);
      const income = parseNullableInt(row.incomeTotalInclTax);
      if (!scheduledDate || (expense === null && income === null)) {
        invalidRows += 1;
        continue;
      }
      preparedRows.push({
        rowNumber: i + 1,
        managementNo,
        projectName,
        expense,
        income,
        customerName,
        scheduledDateRaw,
        scheduledDate
      });
    }

    if (preparedRows.length === 0) {
      return c.json({ ok: true, newEntries: [], diffEntries: [], invalidRows, message: '取り込み可能な行がありませんでした。' });
    }

    // 既存の同一managementNoのデータを取得する
    const managementNos = [...new Set(preparedRows.map((r) => r.managementNo).filter((v) => v !== ''))];
    const existingMap = new Map<string, { id: number; title: string; amount: number; scheduled_date: string; customer_name: string; type: 'income' | 'expense' }>();
    if (managementNos.length > 0) {
      const keyChunkSize = 80;
      for (let i = 0; i < managementNos.length; i += keyChunkSize) {
        const part = managementNos.slice(i, i + keyChunkSize);
        const placeholders = part.map(() => '?').join(', ');
        const rows = await c.env.DB.prepare(
          `SELECT id, title, amount, type, scheduled_date, customer_name, import_management_no
           FROM cashflow_entries
           WHERE organization_id = ? AND deleted_at IS NULL AND import_management_no IN (${placeholders})`
        ).bind(organizationId, ...part).all<{ id: number; title: string; amount: number; type: 'income' | 'expense'; scheduled_date: string; customer_name: string | null; import_management_no: string }>();
        for (const row of rows.results ?? []) {
          const key = `${String(row.import_management_no)}::${row.type}`;
          existingMap.set(key, {
            id: Number(row.id),
            title: row.title || '',
            amount: Number(row.amount || 0),
            scheduled_date: row.scheduled_date || '',
            customer_name: row.customer_name || '',
            type: row.type
          });
        }
      }
    }

    const newEntries: Array<any> = [];
    const diffEntries: Array<any> = [];

    for (const row of preparedRows) {
      const title = (row.projectName || row.managementNo || row.customerName || '楽々販売取込').slice(0, 120);
      
      const checkAndPush = (amount: number, type: 'income' | 'expense') => {
        const key = `${row.managementNo}::${type}`;
        const existing = existingMap.get(key);
        if (!existing) {
          // 新規
          newEntries.push({
            managementNo: row.managementNo,
            type,
            title,
            amount,
            scheduledDate: row.scheduledDate,
            customerName: row.customerName
          });
        } else {
          // 比較 (件名「title」は文字コード起因の文字化け・誤検出を避けるため、比較検証の対象から除外します)
          const hasDiff = 
            existing.amount !== amount ||
            existing.scheduled_date !== row.scheduledDate ||
            existing.customer_name !== row.customerName;
          
          if (hasDiff) {
            diffEntries.push({
              id: existing.id,
              managementNo: row.managementNo,
              type,
              // 上書き更新時にDBの既存の綺麗な件名が文字化け文字で上書きされないよう、
              // 新しい件名（new）にも既存の件名（existing.title）をそのまま使用します
              title: { old: existing.title, new: existing.title },
              amount: { old: existing.amount, new: amount },
              scheduledDate: { old: existing.scheduled_date, new: row.scheduledDate },
              customerName: { old: existing.customer_name, new: row.customerName }
            });
          }
        }
      };

      if (row.income !== null && row.income > 0) {
        checkAndPush(row.income, 'income');
      }
      if (row.expense !== null && row.expense > 0) {
        checkAndPush(row.expense, 'expense');
      }
    }

    return c.json({
      ok: true,
      newEntries,
      diffEntries,
      invalidRows,
      totalRows: preparedRows.length
    });
  } catch (error) {
    console.error('rakuraku import preview failed', { userId: user.id, error });
    return c.json({ ok: false, errorCode: CSV_IMPORT_ERROR_CODES.internalError, error: 'CSV解析中にエラーが発生しました。' }, 500);
  }
});

app.post('/api/import/rakuraku/commit', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) {
    const status = auth.status === 401 ? 401 : 403;
    const message = status === 401 ? 'Unauthorized' : 'Forbidden';
    const errorCode = status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN';
    return c.json({ ok: false, errorCode, error: message, message }, status);
  }
  const { user, organizationId } = auth;

  try {
    const body = await parseJsonBody<{
      newEntries?: Array<{
        managementNo: string;
        type: 'income' | 'expense';
        title: string;
        amount: number;
        scheduledDate: string;
        customerName: string;
      }>;
      updatedEntries?: Array<{
        id: number;
        managementNo: string;
        type: 'income' | 'expense';
        title: string;
        amount: number;
        scheduledDate: string;
        customerName: string;
      }>;
    }>(c);

    if (!body) {
      return c.json({ ok: false, error: 'リクエストボディがありません。' }, 400);
    }

    const { newEntries = [], updatedEntries = [] } = body;
    if (newEntries.length === 0 && updatedEntries.length === 0) {
      return c.json({ ok: true, insertedCount: 0, updatedCount: 0, message: '適用するデータがありません。' });
    }

    const monthSet = new Set(newEntries.map((r) => r.scheduledDate.slice(0, 7)));
    for (const r of updatedEntries) {
      monthSet.add(r.scheduledDate.slice(0, 7));
    }
    const monthList = [...monthSet];
    const orderMap = new Map<string, number>();
    if (monthList.length > 0) {
      for (const m of monthList) orderMap.set(m, 0);
      const monthChunkSize = 80;
      for (let i = 0; i < monthList.length; i += monthChunkSize) {
        const chunk = monthList.slice(i, i + monthChunkSize);
        const monthPlaceholders = chunk.map(() => '?').join(', ');
        const maxRows = await c.env.DB.prepare(
          `SELECT substr(scheduled_date, 1, 7) as month, COALESCE(MAX(order_index), 0) as max_order
           FROM cashflow_entries
           WHERE organization_id = ? AND deleted_at IS NULL AND substr(scheduled_date, 1, 7) IN (${monthPlaceholders})
           GROUP BY substr(scheduled_date, 1, 7)`
        )
          .bind(organizationId, ...chunk)
          .all<{ month: string; max_order: number }>();
        for (const row of maxRows.results ?? []) {
          orderMap.set(row.month, Number(row.max_order ?? 0));
        }
      }
    }

    const statements: D1PreparedStatement[] = [];
    const sourceFileName = 'rakuraku_import.csv';
    const batchId = `web_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

    // 1. UPDATE処理の登録
    let updatedCount = 0;
    for (const row of updatedEntries) {
      statements.push(
        c.env.DB.prepare(
          `UPDATE cashflow_entries
           SET title = ?, amount = ?, scheduled_date = ?, customer_name = ?, updated_at = datetime('now'),
               import_source_file_name = ?, import_batch_id = ?
           WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
        ).bind(
          row.title,
          row.amount,
          row.scheduledDate,
          row.customerName || null,
          sourceFileName,
          batchId,
          row.id,
          organizationId
        )
      );
      updatedCount += 1;
    }

    // 2. INSERT処理の登録
    let insertedCount = 0;
    for (const row of newEntries) {
      const month = row.scheduledDate.slice(0, 7);
      let nextOrder = Number(orderMap.get(month) ?? 0);
      nextOrder += 1;
      orderMap.set(month, nextOrder);

      statements.push(
        c.env.DB.prepare(
          `INSERT INTO cashflow_entries
            (user_id, organization_id, title, amount, type, scheduled_date, order_index, note, account_name,
             actual_transaction_date, customer_name, staff_name, label_color, is_sample, is_completed,
             created_by_user_id, import_source_file_name, import_management_no, import_batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, '', 0, 0, ?, ?, ?, ?)`
        ).bind(
          user.id,
          organizationId,
          row.title,
          row.amount,
          row.type,
          row.scheduledDate,
          nextOrder,
          row.customerName || null,
          user.id,
          sourceFileName,
          row.managementNo || null,
          batchId
        )
      );
      insertedCount += 1;
    }

    if (statements.length > 0) {
      const writeChunkSize = 40;
      for (let i = 0; i < statements.length; i += writeChunkSize) {
        const chunk = statements.slice(i, i + writeChunkSize);
        await c.env.DB.batch(chunk);
      }
    }

    return c.json({
      ok: true,
      insertedCount,
      updatedCount,
      message: 'インポート適用が完了しました。'
    });
  } catch (error) {
    console.error('rakuraku import commit failed', { userId: user.id, error });
    return c.json({ ok: false, error: 'インポート確定処理中にエラーが発生しました。' }, 500);
  }
});

app.post('/api/import/cashflow', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) {
    const status = auth.status === 401 ? 401 : 403;
    const message = status === 401 ? 'Unauthorized' : 'Forbidden';
    const errorCode = status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN';
    return c.json({ ok: false, errorCode, error: message, message }, status);
  }
  const { user, organizationId } = auth;

  try {
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ ok: false, error: 'Content-Type must be multipart/form-data' }, 415);
    }
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch (error) {
      console.error('cashflow import multipart parse failed', { userId: user.id, error });
      return c.json({ ok: false, error: 'multipart/form-data の解析に失敗しました。' }, 400);
    }
    const file = form.file;
    if (!(file instanceof File)) {
      return c.json({ ok: false, error: 'CSVファイルがありません。' }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = decodeShiftJisLike(bytes);
    
    // Parse CSV lines
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((v) => v.trim() !== '');
    if (lines.length === 0) {
      return c.json({ ok: false, error: 'CSVファイルが空です。' }, 400);
    }
    if (lines.length === 1) {
      return c.json({ ok: false, error: 'CSVデータ行がありません。' }, 400);
    }

    const header = parseCsvLineSimple(lines[0].replace(/^\uFEFF/, ''));
    const idx = {
      id: header.indexOf('ID'),
      scheduledDate: header.indexOf('予定日'),
      type: header.indexOf('区分'),
      cfCategory: header.indexOf('CF区分'),
      title: header.indexOf('件名'),
      amount: header.indexOf('金額'),
      note: header.indexOf('メモ'),
      actualDate: header.indexOf('入出金日'),
      customerName: header.indexOf('顧客名'),
      staffName: header.indexOf('担当社員名'),
      completed: header.indexOf('完了状態'),
      labelColor: header.indexOf('ラベル'),
      managementNo: header.indexOf('管理番号')
    };

    // 予定日, 区分, 件名, 金額 は必須項目
    if (idx.scheduledDate < 0 || idx.type < 0 || idx.title < 0 || idx.amount < 0) {
      return c.json({ ok: false, error: 'CSVヘッダーに必要な項目（予定日, 区分, 件名, 金額）が含まれていません。' }, 400);
    }

    const parsedRows: Array<{
      id: string;
      scheduledDate: string;
      type: 'income' | 'expense';
      title: string;
      amount: number;
      note: string;
      actualDate: string;
      customerName: string;
      staffName: string;
      isCompleted: number;
      labelColor: string;
      managementNo: string;
      cfCategory: string;
      cfCategorySpecified: boolean;
      rowNum: number;
    }> = [];

    let failedRows = 0;
    const rowErrors: Array<{ rowNumber: number; message: string }> = [];

    for (let i = 1; i < lines.length; i += 1) {
      const cols = parseCsvLineSimple(lines[i]);
      const rawId = idx.id >= 0 ? String(cols[idx.id] ?? '').trim() : '';
      const rawScheduledDate = String(cols[idx.scheduledDate] ?? '').trim();
      const rawType = String(cols[idx.type] ?? '').trim();
      const rawTitle = String(cols[idx.title] ?? '').trim();
      const rawAmountVal = String(cols[idx.amount] ?? '').replaceAll(',', '').trim();
      const rawAmount = Number(rawAmountVal);
      const rawNote = idx.note >= 0 ? String(cols[idx.note] ?? '').trim() : '';
      const rawActualDate = idx.actualDate >= 0 ? String(cols[idx.actualDate] ?? '').trim() : '';
      const rawCustomerName = idx.customerName >= 0 ? String(cols[idx.customerName] ?? '').trim() : '';
      const rawStaffName = idx.staffName >= 0 ? String(cols[idx.staffName] ?? '').trim() : '';
      const rawCompleted = idx.completed >= 0 ? String(cols[idx.completed] ?? '').trim() : '';
      const rawLabelColor = idx.labelColor >= 0 ? String(cols[idx.labelColor] ?? '').trim() : '';
      const rawManagementNo = idx.managementNo >= 0 ? String(cols[idx.managementNo] ?? '').trim() : '';
      const rawCfCategory = idx.cfCategory >= 0 ? String(cols[idx.cfCategory] ?? '').trim() : '';

      const scheduledDate = parseSlashOrIsoDate(rawScheduledDate);
      if (!scheduledDate) {
        rowErrors.push({ rowNumber: i + 1, message: '予定日の日付形式が正しくありません。' });
        failedRows += 1;
        continue;
      }
      let type: 'income' | 'expense';
      if (rawType === '入金') {
        type = 'income';
      } else if (rawType === '出金') {
        type = 'expense';
      } else {
        rowErrors.push({ rowNumber: i + 1, message: '区分は「入金」または「出金」で入力してください。' });
        failedRows += 1;
        continue;
      }

      if (!rawTitle) {
        rowErrors.push({ rowNumber: i + 1, message: '件名が入力されていません。' });
        failedRows += 1;
        continue;
      }

      if (rawAmountVal === '' || isNaN(rawAmount) || rawAmount < 0) {
        rowErrors.push({ rowNumber: i + 1, message: '金額が正しくありません（1以上の整数）。' });
        failedRows += 1;
        continue;
      }

      const isCompleted = rawCompleted === '完了' ? 1 : 0;
      const actualDate = parseSlashOrIsoDate(rawActualDate) || null;

      parsedRows.push({
        id: rawId,
        scheduledDate,
        type,
        title: rawTitle.slice(0, 120),
        amount: rawAmount,
        note: rawNote || '',
        actualDate: actualDate || '',
        customerName: rawCustomerName || '',
        staffName: rawStaffName || '',
        isCompleted,
        labelColor: rawLabelColor || '',
        managementNo: rawManagementNo || '',
        cfCategory: rawCfCategory || '',
        cfCategorySpecified: idx.cfCategory >= 0,
        rowNum: i + 1
      });
    }

    // 月ごとのorder_indexの初期値を準備
    const monthSet = new Set(parsedRows.filter(r => !r.id).map(r => r.scheduledDate.slice(0, 7)));
    const monthList = [...monthSet];
    const orderMap = new Map<string, number>();
    if (monthList.length > 0) {
      for (const m of monthList) orderMap.set(m, 0);
      const monthChunkSize = 80;
      for (let i = 0; i < monthList.length; i += monthChunkSize) {
        const chunk = monthList.slice(i, i + monthChunkSize);
        const monthPlaceholders = chunk.map(() => '?').join(', ');
        const maxRows = await c.env.DB.prepare(
          `SELECT substr(scheduled_date, 1, 7) as month, COALESCE(MAX(order_index), 0) as max_order
           FROM cashflow_entries
           WHERE organization_id = ? AND deleted_at IS NULL AND substr(scheduled_date, 1, 7) IN (${monthPlaceholders})
           GROUP BY substr(scheduled_date, 1, 7)`
        )
          .bind(organizationId, ...chunk)
          .all<{ month: string; max_order: number }>();
        for (const row of maxRows.results ?? []) {
          orderMap.set(row.month, Number(row.max_order ?? 0));
        }
      }
    }

    // 指定されたIDがこの組織に属しているか確認
    const idsToCheck = parsedRows.map(r => Number(r.id)).filter(id => !isNaN(id) && id > 0);
    const existingIds = new Set<number>();
    if (idsToCheck.length > 0) {
      const idChunkSize = 80;
      for (let i = 0; i < idsToCheck.length; i += idChunkSize) {
        const chunk = idsToCheck.slice(i, i + idChunkSize);
        const idPlaceholders = chunk.map(() => '?').join(', ');
        const rows = await c.env.DB.prepare(
          `SELECT id FROM cashflow_entries WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${idPlaceholders})`
        ).bind(organizationId, ...chunk).all<{ id: number }>();
        for (const r of rows.results ?? []) {
          existingIds.add(Number(r.id));
        }
      }
    }

    const statements: D1PreparedStatement[] = [];
    let insertedEntries = 0;
    let updatedEntries = 0;

    for (const row of parsedRows) {
      const idNum = Number(row.id);
      if (row.id) {
        if (isNaN(idNum) || idNum <= 0) {
          rowErrors.push({ rowNumber: row.rowNum, message: `指定されたID（${row.id}）が不正です。` });
          failedRows += 1;
          continue;
        }
        if (!existingIds.has(idNum)) {
          rowErrors.push({ rowNumber: row.rowNum, message: `指定されたID（${row.id}）が存在しないか、更新権限がありません。` });
          failedRows += 1;
          continue;
        }

        // UPDATE
        statements.push(
          c.env.DB.prepare(
            `UPDATE cashflow_entries
             SET scheduled_date = ?, type = ?, title = ?, amount = ?, note = ?, actual_transaction_date = ?,
                 customer_name = ?, staff_name = ?, is_completed = ?, label_color = ?,
                 cf_category = CASE WHEN ? = 1 THEN ? ELSE cf_category END,
                 import_management_no = ?,
                 updated_at = datetime('now')
             WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
          ).bind(
            row.scheduledDate,
            row.type,
            row.title,
            row.amount,
            row.note || null,
            row.actualDate || null,
            row.customerName || null,
            row.staffName || null,
            row.isCompleted,
            row.labelColor || '',
            row.cfCategorySpecified ? 1 : 0,
            row.cfCategorySpecified ? (row.cfCategory || null) : null,
            row.managementNo || null,
            idNum,
            organizationId
          )
        );
        updatedEntries += 1;
      } else {
        // INSERT
        const month = row.scheduledDate.slice(0, 7);
        let nextOrder = Number(orderMap.get(month) ?? 0);
        nextOrder += 1;
        orderMap.set(month, nextOrder);

        statements.push(
          c.env.DB.prepare(
            `INSERT INTO cashflow_entries
              (user_id, organization_id, title, amount, type, scheduled_date, order_index, note, account_name,
               actual_transaction_date, customer_name, staff_name, label_color, cf_category, is_sample, is_completed, created_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?)`
          ).bind(
            user.id,
            organizationId,
            row.title,
            row.amount,
            row.type,
            row.scheduledDate,
            nextOrder,
            row.note || null,
            row.actualDate || null,
            row.customerName || null,
            row.staffName || null,
            row.labelColor || '',
            row.cfCategory || null,
            row.isCompleted,
            user.id
          )
        );
        insertedEntries += 1;
      }
    }

    if (statements.length > 0) {
      const writeChunkSize = 40;
      for (let i = 0; i < statements.length; i += writeChunkSize) {
        const chunk = statements.slice(i, i + writeChunkSize);
        await c.env.DB.batch(chunk);
      }
    }

    return c.json({
      ok: true,
      insertedEntries,
      updatedEntries,
      failedRows,
      rowErrors,
      message: 'インポートが完了しました。'
    });
  } catch (error) {
    console.error('cashflow import failed', { userId: user.id, error });
    return c.json({ ok: false, error: 'CSV取り込み中にエラーが発生しました。' }, 500);
  }
});

app.post('/api/sample/load', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  const titles = ['売上入金', '受託入金', '運用入金', '外注費', '人件費', '交通費', '広告費', '通信費', '家賃', '備品購入'];
  const notes = ['定期', 'スポット', '月次', '契約分', '調整', '概算', '請求ベース'];
  const accounts = ['三井住友口座', '和気口座', '那須口座'];
  const customers = ['A商事', 'B物産', 'Cテック', 'Dフーズ', 'E物流'];
  const staffs = ['佐藤', '鈴木', '高橋', '田中', '伊藤'];
  const months = [
    '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
    '2026-01', '2026-02', '2026-03', '2026-04', '2026-05'
  ];
  const incomeDays = [5, 12, 20, 27];
  const incomeAmounts = [420000, 360000, 310000, 280000];
  const expenseDays = [2, 7, 10, 15, 18, 24];
  const expenseAmounts = [190000, 130000, 95000, 120000, 85000, 70000];
  const stmts: D1PreparedStatement[] = [];

  // Rebuild sample data each time to avoid old format leftovers.
  stmts.push(
    c.env.DB.prepare(
      `UPDATE cashflow_entries
       SET deleted_at = datetime('now'), updated_at = datetime('now')
       WHERE organization_id = ? AND is_sample = 1 AND deleted_at IS NULL`
    ).bind(organizationId)
  );

  for (const month of months) {
    let orderIndex = 1;
    for (let i = 0; i < incomeDays.length; i += 1) {
      const day = String(incomeDays[i]).padStart(2, '0');
      const title = titles[i % 3];
      const note = notes[i % notes.length] + ' サンプル（黒字）';
      const account = accounts[i % accounts.length];
      const customer = customers[(i + 1) % customers.length];
      const staff = staffs[(i + 2) % staffs.length];
      const isCompleted = i < 3 ? 1 : 0;
      const actualDate = isCompleted ? `${month}-${String(Math.min(incomeDays[i] + 1, 28)).padStart(2, '0')}` : null;
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO cashflow_entries
            (user_id,organization_id,title,amount,type,scheduled_date,order_index,note,account_name,actual_transaction_date,customer_name,staff_name,is_sample,is_completed,created_by_user_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          user.id,
          organizationId,
          title,
          incomeAmounts[i],
          'income',
          `${month}-${day}`,
          orderIndex,
          note,
          account,
          actualDate,
          customer,
          staff,
          1,
          isCompleted,
          user.id
        )
      );
      orderIndex += 1;
    }

    for (let i = 0; i < expenseDays.length; i += 1) {
      const day = String(expenseDays[i]).padStart(2, '0');
      const title = titles[3 + (i % 7)];
      const note = notes[(i + 2) % notes.length] + ' サンプル（出金）';
      const account = accounts[(i + 1) % accounts.length];
      const customer = customers[i % customers.length];
      const staff = staffs[(i + 3) % staffs.length];
      const isCompleted = i < 4 ? 1 : 0;
      const actualDate = isCompleted ? `${month}-${String(Math.min(expenseDays[i] + 1, 28)).padStart(2, '0')}` : null;
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO cashflow_entries
            (user_id,organization_id,title,amount,type,scheduled_date,order_index,note,account_name,actual_transaction_date,customer_name,staff_name,is_sample,is_completed,created_by_user_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          user.id,
          organizationId,
          title,
          expenseAmounts[i],
          'expense',
          `${month}-${day}`,
          orderIndex,
          note,
          account,
          actualDate,
          customer,
          staff,
          1,
          isCompleted,
          user.id
        )
      );
      orderIndex += 1;
    }
  }

  await c.env.DB.batch(stmts);
  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
     VALUES (?, 'add', 'sample_load', ?)`
  ).bind(user.id, JSON.stringify({ range: '2025-08..2026-05', perMonth: 10, count: stmts.length - 1 })).run();
  return c.json({ ok: true, inserted: stmts.length - 1, range: '2025-08 to 2026-05', perMonth: 10 });
});

app.delete('/api/sample', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  const result = await c.env.DB.prepare(
    `UPDATE cashflow_entries SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE organization_id = ? AND is_sample = 1 AND deleted_at IS NULL`
  ).bind(organizationId).run();
  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
     VALUES (?, 'delete', 'sample_load', ?)`
  ).bind(user.id, JSON.stringify({ affected: result.meta.changes ?? 0 })).run();
  return c.json({ ok: true, affected: result.meta.changes ?? 0 });
});

app.delete('/api/entries', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  const entryResult = await c.env.DB.prepare(
    `UPDATE cashflow_entries
     SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE organization_id = ? AND deleted_at IS NULL`
  ).bind(organizationId).run();
  const importHistoryResult = await c.env.DB.prepare(
    `DELETE FROM rakuraku_cashflow_import_rows
     WHERE user_id = ?`
  ).bind(user.id).run();
  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
     VALUES (?, 'delete', 'cashflow_entry_all', ?)`
  ).bind(user.id, JSON.stringify({
    affected: entryResult.meta.changes ?? 0,
    clearedImportHistoryRows: importHistoryResult.meta.changes ?? 0
  })).run();
  return c.json({
    ok: true,
    affected: entryResult.meta.changes ?? 0,
    clearedImportHistoryRows: importHistoryResult.meta.changes ?? 0
  });
});

app.post('/api/entries/reorder', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;

  const body = await parseJsonBody<{ year?: string; orderedIds?: number[] }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  const year = parseYear(body.year);
  if (!year) return c.json({ error: 'Invalid year. Use YYYY.' }, 400);
  const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds : [];

  if (orderedIds.length === 0 || orderedIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    return c.json({ error: 'Invalid payload' }, 400);
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    return c.json({ error: 'Invalid payload' }, 400);
  }

  const listed = await c.env.DB.prepare(
    `SELECT id FROM cashflow_entries
     WHERE organization_id = ? AND substr(scheduled_date, 1, 4) = ? AND deleted_at IS NULL`
  )
    .bind(organizationId, year)
    .all<{ id: number }>();

  const currentIds = (listed.results ?? []).map((r) => r.id).sort((a, b) => a - b);
  if (currentIds.length === 0) return c.json({ error: 'No entries in year' }, 400);
  if (currentIds.length !== orderedIds.length) return c.json({ error: 'IDs mismatch' }, 400);
  const candidate = [...orderedIds].sort((a, b) => a - b);
  if (JSON.stringify(currentIds) !== JSON.stringify(candidate)) {
    return c.json({ error: 'IDs mismatch' }, 400);
  }

  const stmts = orderedIds.map((id, idx) =>
    c.env.DB.prepare(
      `UPDATE cashflow_entries
       SET order_index = ?, updated_at = datetime('now')
       WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
    ).bind(idx + 1, id, organizationId)
  );

  await c.env.DB.batch(stmts);
  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
     VALUES (?, 'edit', 'cashflow_entry_reorder', ?)`
  ).bind(user.id, JSON.stringify({ year, count: orderedIds.length })).run();
  return c.json({ ok: true });
});

app.delete('/api/entries/:id', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid entry id' }, 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE cashflow_entries
     SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(id, organizationId)
    .run();

  if (!result.success) {
    return c.json({ error: 'Failed to delete entry' }, 500);
  }
  if ((result.meta?.changes ?? 0) === 0) {
    return c.json({ error: 'Entry not found' }, 404);
  }
  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, target_id, detail)
     VALUES (?, 'delete', 'cashflow_entry', ?, ?)`
  ).bind(user.id, id, JSON.stringify({ deletedAt: new Date().toISOString() })).run();
  return c.json({ ok: true });
});

app.post('/api/entries/:id/complete', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

  const current = await c.env.DB.prepare(
    `SELECT is_completed
     FROM cashflow_entries
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(id, organizationId)
    .first<{ is_completed: number }>();
  if (!current) return c.json({ error: 'Entry not found' }, 404);

  const nextCompleted = Number(current.is_completed) === 1 ? 0 : 1;
  const result = await c.env.DB.prepare(
    `UPDATE cashflow_entries
     SET is_completed = ?, updated_at = datetime('now')
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(nextCompleted, id, organizationId)
    .run();

  if ((result.meta.changes ?? 0) < 1) return c.json({ error: 'Entry not found' }, 404);
  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, target_id, detail)
     VALUES (?, 'edit', 'cashflow_entry', ?, ?)`
  ).bind(user.id, id, JSON.stringify({ is_completed: nextCompleted })).run();
  return c.json({ ok: true, isCompleted: nextCompleted });
});

app.post('/api/entries/:id/date', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

  const body = await parseJsonBody<{ scheduledDate?: string }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  const scheduledDate = parseDateOnly(body.scheduledDate);
  if (!scheduledDate) return c.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, 400);

  const existing = await c.env.DB.prepare(
    `SELECT scheduled_date, order_index
     FROM cashflow_entries
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(id, organizationId)
    .first<{ scheduled_date: string; order_index: number }>();
  if (!existing) return c.json({ error: 'Entry not found' }, 404);

  const fromMonth = existing.scheduled_date.slice(0, 7);
  const toMonth = scheduledDate.slice(0, 7);

  let nextOrder = Number(existing.order_index);
  if (fromMonth !== toMonth) {
    const maxRow = await c.env.DB.prepare(
      `SELECT COALESCE(MAX(order_index), 0) as max_order
       FROM cashflow_entries
       WHERE organization_id = ? AND substr(scheduled_date, 1, 7) = ? AND deleted_at IS NULL`
    )
      .bind(organizationId, toMonth)
      .first<{ max_order: number }>();
    nextOrder = Number(maxRow?.max_order ?? 0) + 1;
  }

  await c.env.DB.prepare(
    `UPDATE cashflow_entries
     SET scheduled_date = ?, order_index = ?, updated_at = datetime('now')
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(scheduledDate, nextOrder, id, organizationId)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, target_id, detail)
     VALUES (?, 'edit', 'cashflow_entry', ?, ?)`
  ).bind(user.id, id, JSON.stringify({
    scheduledDateFrom: existing.scheduled_date,
    scheduledDateTo: scheduledDate
  })).run();

  return c.json({ ok: true });
});

app.post('/api/entries/:id/actual-date', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

  const body = await parseJsonBody<{ actualTransactionDate?: string | null }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  const raw = typeof body.actualTransactionDate === 'string' ? body.actualTransactionDate.trim() : '';
  const actualTransactionDate = raw === '' ? null : parseDateOnly(raw);
  if (raw !== '' && !actualTransactionDate) {
    return c.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE cashflow_entries
     SET actual_transaction_date = ?, updated_at = datetime('now')
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(actualTransactionDate, id, organizationId)
    .run();
  if ((result.meta?.changes ?? 0) < 1) return c.json({ error: 'Entry not found' }, 404);

  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, target_id, detail)
     VALUES (?, 'edit', 'cashflow_entry', ?, ?)`
  ).bind(user.id, id, JSON.stringify({ actual_transaction_date: actualTransactionDate })).run();

  return c.json({ ok: true });
});

app.post('/api/entries/:id/color', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

  const body = await parseJsonBody<{ labelColor?: string }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  const labelColor = typeof body.labelColor === 'string' ? body.labelColor.trim() : '';
  const allowedColors = new Set<string>(ENTRY_LABEL_COLORS);
  if (!allowedColors.has(labelColor)) return c.json({ error: 'Invalid color' }, 400);

  const result = await c.env.DB.prepare(
    `UPDATE cashflow_entries
     SET label_color = ?, updated_at = datetime('now')
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(labelColor, id, organizationId)
    .run();
  if ((result.meta?.changes ?? 0) < 1) return c.json({ error: 'Entry not found' }, 404);

  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, target_id, detail)
     VALUES (?, 'edit', 'cashflow_entry', ?, ?)`
  ).bind(user.id, id, JSON.stringify({ label_color: labelColor })).run();

  return c.json({ ok: true, labelColor });
});

app.post('/api/entries/:id/cf-category', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

  const body = await parseJsonBody<{ cfCategory?: string }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  const cfCategory = typeof body.cfCategory === 'string' ? body.cfCategory.trim() : '';
  const entryRow = await c.env.DB.prepare(
    `SELECT type
     FROM cashflow_entries
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(id, organizationId)
    .first<{ type: 'income' | 'expense' }>();
  if (!entryRow) return c.json({ error: 'Entry not found' }, 404);
  const allowedCategories = new Set<string>(['', ...getCfCategoriesByEntryType(entryRow.type)]);
  if (!allowedCategories.has(cfCategory)) return c.json({ error: 'Invalid cf category' }, 400);

  const result = await c.env.DB.prepare(
    `UPDATE cashflow_entries
     SET cf_category = ?, updated_at = datetime('now')
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(cfCategory, id, organizationId)
    .run();
  if ((result.meta?.changes ?? 0) < 1) return c.json({ error: 'Entry not found' }, 404);

  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, target_id, detail)
     VALUES (?, 'edit', 'cashflow_entry', ?, ?)`
  ).bind(user.id, id, JSON.stringify({ cf_category: cfCategory })).run();

  return c.json({ ok: true, cfCategory });
});

app.post('/api/entries/bulk', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;

  const body = await parseJsonBody<{
    ids?: number[];
    action?: 'set_date' | 'set_actual_date' | 'set_completed';
    scheduledDate?: string;
    actualTransactionDate?: string | null;
    isCompleted?: boolean;
  }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const ids = Array.isArray(body.ids) ? body.ids : [];
  const normalizedIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (normalizedIds.length === 0 || normalizedIds.length > 500) {
    return c.json({ error: 'Invalid ids. Use 1..500 integer ids.' }, 400);
  }
  if (!body.action || !['set_date', 'set_actual_date', 'set_completed'].includes(body.action)) {
    return c.json({ error: 'Invalid action' }, 400);
  }

  const chunkSize = 80;
  const existingIds = new Set<number>();
  for (let i = 0; i < normalizedIds.length; i += chunkSize) {
    const chunk = normalizedIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const existing = await c.env.DB.prepare(
      `SELECT id
       FROM cashflow_entries
       WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`
    ).bind(organizationId, ...chunk).all<{ id: number }>();
    for (const row of existing.results ?? []) existingIds.add(Number(row.id));
  }
  if (existingIds.size !== normalizedIds.length) {
    return c.json({ error: 'Some entries were not found in your organization.' }, 400);
  }

  if (body.action === 'set_date') {
    const scheduledDate = parseDateOnly(body.scheduledDate);
    if (!scheduledDate) return c.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, 400);
    const month = scheduledDate.slice(0, 7);
    const maxRow = await c.env.DB.prepare(
      `SELECT COALESCE(MAX(order_index), 0) AS max_order
       FROM cashflow_entries
       WHERE organization_id = ? AND deleted_at IS NULL AND substr(scheduled_date, 1, 7) = ?`
    ).bind(organizationId, month).first<{ max_order: number }>();
    let nextOrder = Number(maxRow?.max_order ?? 0);
    const stmts = normalizedIds.map((id) => {
      nextOrder += 1;
      return c.env.DB.prepare(
        `UPDATE cashflow_entries
         SET scheduled_date = ?, order_index = ?, updated_at = datetime('now')
         WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
      ).bind(scheduledDate, nextOrder, id, organizationId);
    });
    await c.env.DB.batch(stmts);
    await c.env.DB.prepare(
      `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
       VALUES (?, 'edit', 'cashflow_entry_bulk_date', ?)`
    ).bind(user.id, JSON.stringify({ ids: normalizedIds, scheduledDate })).run();
    return c.json({ ok: true, affected: normalizedIds.length });
  }

  if (body.action === 'set_actual_date') {
    const raw = typeof body.actualTransactionDate === 'string' ? body.actualTransactionDate.trim() : '';
    const actualTransactionDate = raw === '' ? null : parseDateOnly(raw);
    if (raw !== '' && !actualTransactionDate) {
      return c.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, 400);
    }
    let affected = 0;
    for (let i = 0; i < normalizedIds.length; i += chunkSize) {
      const chunk = normalizedIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await c.env.DB.prepare(
        `UPDATE cashflow_entries
         SET actual_transaction_date = ?, updated_at = datetime('now')
         WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`
      ).bind(actualTransactionDate, organizationId, ...chunk).run();
      affected += Number(result.meta.changes ?? 0);
    }
    await c.env.DB.prepare(
      `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
       VALUES (?, 'edit', 'cashflow_entry_bulk_actual_date', ?)`
    ).bind(user.id, JSON.stringify({ ids: normalizedIds, actualTransactionDate })).run();
    return c.json({ ok: true, affected });
  }

  if (typeof body.isCompleted !== 'boolean') {
    return c.json({ error: 'isCompleted must be boolean.' }, 400);
  }
  const completedNum = body.isCompleted ? 1 : 0;
  let affected = 0;
  for (let i = 0; i < normalizedIds.length; i += chunkSize) {
    const chunk = normalizedIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await c.env.DB.prepare(
      `UPDATE cashflow_entries
       SET is_completed = ?, updated_at = datetime('now')
       WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`
    ).bind(completedNum, organizationId, ...chunk).run();
    affected += Number(result.meta.changes ?? 0);
  }
  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
     VALUES (?, 'edit', 'cashflow_entry_bulk_complete', ?)`
  ).bind(user.id, JSON.stringify({ ids: normalizedIds, is_completed: completedNum })).run();
  return c.json({ ok: true, affected });
});

function renderAuthPage(mode: 'login' | 'register' | 'forgot' | 'reset', error?: string) {
  const isLogin = mode === 'login';
  const isRegister = mode === 'register';
  const isForgot = mode === 'forgot';
  const isReset = mode === 'reset';
  const title = isLogin ? 'ログイン' : isRegister ? '新規登録' : isForgot ? 'パスワード再設定' : '新しいパスワード設定';
  const action = isLogin || isRegister ? `/${mode}` : isForgot ? '/forgot-password' : '/reset-password';
  const submitLabel = isLogin ? 'ログイン' : isRegister ? 'アカウント作成' : isForgot ? '再設定メールを送信' : 'パスワードを更新';
  const helper = 'ログイン情報は管理者から案内されたアカウントをご利用ください。';
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} | Cashflow</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: "Noto Sans JP", "Hiragino Sans", sans-serif; margin: 0; background: #f4f6f8; color: #1f2933; }
    .box { max-width: 420px; margin: 8vh auto; background: #fff; border: 1px solid #d9e2ec; border-radius: 10px; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 22px; }
    label { display: block; margin: 10px 0 6px; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #bcccdc; border-radius: 8px; padding: 10px; }
    .error { background: #ffe3e3; color: #7f1d1d; border: 1px solid #fecaca; padding: 10px; border-radius: 8px; margin-bottom: 12px; }
    button { margin-top: 14px; width: 100%; border: 0; background: #0f4c81; color: #fff; padding: 11px; border-radius: 8px; font-weight: 700; cursor: pointer; }
    a { color: #0f4c81; text-decoration: none; }
    p { margin-top: 12px; font-size: 14px; }
  </style>
</head>
<body>
  <main class="box">
    <h1>${title}</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="${action}">
      ${isReset ? '<label>再設定トークン</label><input type="text" name="token" placeholder="メールに記載されたトークン" required />' : ''}
      <label>メールアドレス</label>
      <input type="email" name="email" required />
      ${(isLogin || isRegister || isReset) ? '<label>パスワード</label><input type="password" name="password" minlength="8" required />' : ''}
      ${isReset ? '<label>新しいパスワード（確認）</label><input type="password" name="passwordConfirm" minlength="8" required />' : ''}
      <button type="submit">${submitLabel}</button>
    </form>
    <p>${helper}</p>
  </main>
</body>
</html>`;
}

function renderAppPage(email: string, isAdmin: boolean) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cashflow Manager</title>
  <style>
    :root {
      --bg: #eef2f6;
      --panel: #ffffff;
      --line: #d4dde7;
      --text: #1d2733;
      --muted: #5e7188;
      --income: #0d8a4f;
      --expense: #b22a34;
      --accent: #0f4c81;
      --accent-deep: #0b3558;
      --warn-bg: #fff4db;
      --warn-line: #f3d28a;
      --err-bg: #fef0f1;
      --err-line: #f5c2c7;
      --ok-bg: #edf9f1;
      --ok-line: #bce7cb;
      --shadow: 0 6px 20px rgba(10, 36, 64, 0.08);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Noto Sans JP", "Hiragino Sans", sans-serif; background: linear-gradient(180deg, #f7f9fc 0%, var(--bg) 100%); color: var(--text); }
    header { position: sticky; top: 0; z-index: 20; background: linear-gradient(120deg, var(--accent-deep) 0%, #104b77 70%); color: #fff; padding: 14px 20px; box-shadow: var(--shadow); }
    .head-wrap { max-width: 1800px; margin: 0 auto; display: grid; grid-template-columns: 220px 1fr auto; gap: 18px; align-items: center; }
    .brand { min-width: 0; }
    .brand-title { font-size: 20px; font-weight: 700; letter-spacing: .02em; }
    .brand-user { font-size: 12px; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .summary { display: grid; grid-template-columns: repeat(3, minmax(110px, 1fr)); gap: 8px; }
    .sum-card { background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.22); border-radius: 10px; padding: 10px 12px; }
    .sum-label { display: block; font-size: 11px; opacity: .9; margin-bottom: 4px; }
    .sum-value { font-size: 18px; font-weight: 700; letter-spacing: .01em; }
    .sum-value.income { color: #b8ffd4; }
    .sum-value.expense { color: #ffd6da; }
    .sum-value.balance.plus { color: #b8ffd4; }
    .sum-value.balance.minus { color: #ffd6da; }
    .header-warning-slot { max-width: 1800px; margin: 8px auto 0; padding: 0 20px; min-height: 34px; }
    .balance-alert { opacity: 0; transform: translateY(-2px); transition: opacity .15s ease, transform .15s ease; font-size: 12px; font-weight: 700; color: #7a5300; background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; padding: 8px 10px; pointer-events: none; }
    .balance-alert.show { opacity: 1; transform: translateY(0); }

    .main { max-width: 1800px; margin: 18px auto; padding: 0 20px 40px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; box-shadow: 0 1px 0 rgba(15, 47, 74, 0.04); }
    .topline { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
    .section-toggle { border: 1px solid var(--line); background: #fff; color: var(--text); padding: 6px 10px; border-radius: 8px; cursor: pointer; font-size: 12px; }
    .collapsed { display: none; }
    .muted { color: var(--muted); font-size: 12px; }

    .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

    .row { display: grid; gap: 10px; grid-template-columns: 1.5fr 1fr 1fr 1fr 1.1fr 1.5fr auto; }
    .field { min-width: 0; }
    .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
    input, select, button { border-radius: 8px; border: 1px solid #b9c8d9; padding: 9px 10px; font-size: 14px; background: #fff; color: var(--text); }
    input:focus, select:focus, button:focus { outline: 2px solid rgba(15,76,129,.2); outline-offset: 1px; border-color: var(--accent); }
    .field-hint { margin-top: 4px; font-size: 11px; color: var(--muted); min-height: 1.2em; }
    .field-hint.error { color: #8e1f2b; }
    .primary { background: var(--accent); color: #fff; border: 0; font-weight: 700; }
    .primary:hover { background: #0d426f; }
    .secondary { background: #fff; }

    .banner { display: none; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; font-size: 13px; }
    .banner.show { display: block; }
    .banner.error { background: var(--err-bg); border: 1px solid var(--err-line); color: #7f1d1d; }
    .banner.warn { background: var(--warn-bg); border: 1px solid var(--warn-line); color: #7a5300; }
    .banner.ok { background: var(--ok-bg); border: 1px solid var(--ok-line); color: #155e36; }

    .table-wrap { overflow: auto; border: 1px solid #e1e8f0; border-radius: 10px; }
    table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; }
    th, td { border-bottom: 1px solid #e7edf4; text-align: left; padding: 9px 8px; vertical-align: middle; }
    #rows th,
    #rows td {
      white-space: nowrap;
    }
    th { position: sticky; top: 0; z-index: 2; background: #f5f8fb; color: #334e68; font-weight: 700; }
    .table-wrap thead th { white-space: nowrap; }
    tbody tr:hover { background: #fbfdff; }
    tbody tr.completed { background: #f2f4f7; color: #7b8794; }
    tbody tr.completed .amount,
    tbody tr.completed .running { color: #7b8794 !important; }
    .amount { font-variant-numeric: tabular-nums; font-weight: 700; }
    .amount.income { color: var(--income); }
    .amount.expense { color: var(--expense); }
    .running.plus { color: var(--income); font-weight: 700; }
    .running.minus { color: var(--expense); font-weight: 700; }
    #rows th:nth-child(4),
    #rows td:nth-child(4) { white-space: nowrap; min-width: 110px; }
    #rows th:nth-child(5),
    #rows td:nth-child(5) { white-space: nowrap; min-width: 72px; }
    #rows th:nth-child(9),
    #rows td:nth-child(9) { white-space: nowrap; min-width: 110px; }
    #rows th:nth-child(13),
    #rows td:nth-child(13) { white-space: nowrap; min-width: 120px; }
    #rows th:nth-child(14),
    #rows td:nth-child(14) { white-space: nowrap; min-width: 210px; }
    .actions { display: flex; flex-direction: column; gap: 4px; min-width: 210px; }
    .select-cell { text-align: center; width: 52px; }
    .toggle-cell { text-align: center; width: 42px; }
    .toggle-mgmt { width: 24px; height: 24px; border-radius: 999px; padding: 0; line-height: 22px; font-weight: 700; }
    .detail-row td { background: #f8fbff; color: #3a4a5e; font-size: 12px; }
    .bulk-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .bulk-bar .muted { font-size: 12px; }
    .column-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0 0 10px; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fbff; }
    .column-toolbar .muted { font-size: 12px; font-weight: 700; color: #48617a; }
    .column-toggle-group { display: flex; gap: 6px; flex-wrap: wrap; }
    .column-toggle { padding: 6px 9px; font-size: 12px; border: 1px solid #c7d4e3; background: #fff; }
    .column-toggle.is-hidden { background: #eef3f8; color: var(--muted); border-color: #d6e0ea; }
    .is-hidden-col { display: none !important; }
    .action-row { display: flex; gap: 4px; flex-wrap: nowrap; }
    .actions button, .actions select { padding: 5px 6px; font-size: 11px; min-width: 0; white-space: nowrap; }
    .label-dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; margin-right: 6px; border: 1px solid rgba(0,0,0,.15); vertical-align: middle; }
    .label-red { background: #ef4444; }
    .label-orange { background: #f97316; }
    .label-yellow { background: #eab308; }
    .label-green { background: #22c55e; }
    .label-blue { background: #3b82f6; }
    .label-purple { background: #a855f7; }

    @media (max-width: 1000px) {
      .head-wrap { grid-template-columns: 1fr; }
      .summary { grid-template-columns: repeat(3, minmax(100px, 1fr)); }
      .row { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 560px) {
      .summary { grid-template-columns: 1fr; }
      .row { grid-template-columns: 1fr; }
    }

    /* CSVヘルプモーダル用スタイル */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.45);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }
    .modal-box {
      background: #fff;
      padding: 24px;
      border-radius: 12px;
      max-width: 640px;
      width: 90%;
      max-height: 85vh;
      overflow-y: auto;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
      position: relative;
    }
    .modal-close {
      position: absolute;
      top: 14px;
      right: 18px;
      font-size: 26px;
      cursor: pointer;
      color: #888;
      line-height: 1;
    }
    .modal-close:hover {
      color: #333;
    }
    /* ヘルプアイコンのスタイル */
    .help-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #cbd5e1;
      color: #334155;
      font-size: 13px;
      font-weight: bold;
      cursor: pointer;
      margin-left: 6px;
      border: none;
      vertical-align: middle;
      padding: 0;
      line-height: 20px;
      font-family: inherit;
    }
    .help-icon:hover {
      background: #94a3b8;
      color: #0f172a;
    }

    /* 楽楽販売差分モーダル用スタイル */
    .diff-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 10px;
      background: #fff;
    }
    .diff-table th, .diff-table td {
      padding: 8px;
      border: 1px solid var(--line);
      vertical-align: middle;
      text-align: left;
    }
    .diff-old {
      color: var(--expense);
      text-decoration: line-through;
      background-color: #fdf2f2;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .diff-new {
      color: var(--income);
      font-weight: bold;
      background-color: #f0fdf4;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .diff-same {
      color: var(--muted);
    }
  </style>
</head>
<body>
<header>
  <div class="head-wrap">
    <div class="brand">
      <div class="brand-title">Cashflow Manager</div>
      <div class="brand-user" title="${escapeHtml(email)}">${escapeHtml(email)}</div>
    </div>
    <div class="summary" aria-live="polite">
      <div class="sum-card">
        <span class="sum-label">入金予定</span>
        <span class="sum-value income" id="sum-income">0</span>
      </div>
      <div class="sum-card">
        <span class="sum-label">出金予定</span>
        <span class="sum-value expense" id="sum-expense">0</span>
      </div>
      <div class="sum-card">
        <span class="sum-label">差引</span>
        <span class="sum-value balance" id="sum-balance">0</span>
      </div>
    </div>
    <div style="display:flex; gap:8px; align-items:center;">
      <a href="/cashflow-statement" style="display:inline-block; padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.35); color:#fff; text-decoration:none; font-size:13px;">資金繰り表</a>
      <a href="/fiscal" style="display:inline-block; padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.35); color:#fff; text-decoration:none; font-size:13px;">年間サマリー</a>
      ${isAdmin ? '<a href="/admin/backups" style="display:inline-block; padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.35); color:#fff; text-decoration:none; font-size:13px;">バックアップ</a>' : ''}
      ${isAdmin ? '<a href="/audit" style="display:inline-block; padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.35); color:#fff; text-decoration:none; font-size:13px;">監査ログ</a>' : ''}
      <form method="post" action="/logout" style="display:inline-flex;">
        <button class="secondary">ログアウト</button>
      </form>
      <a href="/password-change" style="display:inline-block; padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.35); color:#fff; text-decoration:none; font-size:13px;">パスワード変更</a>
    </div>
  </div>
</header>
<div class="header-warning-slot">
  <div id="balance-alert" class="balance-alert">警告: 今月の差引がマイナスです。資金繰りを確認してください。</div>
</div>

<main class="main">
  <section class="panel">
    <div id="status-banner" class="banner" role="status"></div>
    <div class="topline">
      <strong>年次フィルター</strong>
      <div class="muted">表示・入力対象の年を切り替えます</div>
    </div>
    <div class="toolbar">
      <select id="year"></select>
      <span id="month-caption" class="muted"></span>
    </div>
  </section>

  <section class="panel">
    <div class="topline">
      <strong>資金繰り表</strong>
      <span class="muted">Excelの資金繰り表をWebで確認できるページです。今後この表に仕分け区分ごとの集計を接続します。</span>
    </div>
    <div class="toolbar">
      <a href="/cashflow-statement" class="primary" style="display:inline-block; padding:9px 12px; text-decoration:none;">資金繰り表ページを開く</a>
    </div>
  </section>

  <section class="panel">
    <div class="topline">
      <strong>年間入出金データ（明細）</strong>
      <span class="muted">選択中の年の完了済み入出金データを表示します。残高は0起点で計算します。</span>
      <button id="toggle-annual" class="section-toggle" type="button">展開する</button>
    </div>
    <div id="annual-section-body" class="table-wrap collapsed">
      <table>
        <thead><tr><th>日付</th><th>区分</th><th>件名</th><th>金額</th><th>メモ</th><th>残高</th></tr></thead>
        <tbody id="annual-expense-rows"></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <div class="topline"><strong>入出金予定の追加</strong><span class="muted">金額は整数（円）で入力</span></div>
    <div class="toolbar" style="margin-bottom:10px;">
      <button id="load-sample" type="button">サンプルデータ投入</button>
      <button id="clear-sample" type="button">サンプルデータ削除</button>
      <button id="clear-all-entries" type="button">予定一覧を全削除</button>
      <input id="rakuraku-csv-file" type="file" accept=".csv,text/csv" />
      <button id="import-rakuraku-csv" type="button">楽楽販売CSV読込</button>
    </div>
    <form id="entry-form" class="row" novalidate>
      <div class="field">
        <label for="f-title">件名</label>
        <input id="f-title" name="title" placeholder="例: A社売上入金" required maxlength="80" />
        <div class="field-hint" data-hint-for="title">1-80文字</div>
      </div>
      <div class="field">
        <label for="f-amount">金額</label>
        <input id="f-amount" name="amount" type="number" step="1" min="1" placeholder="例: 120000" required />
        <div class="field-hint" data-hint-for="amount">1円以上の整数</div>
      </div>
      <div class="field">
        <label for="f-type">区分</label>
        <select id="f-type" name="type"><option value="income">入金</option><option value="expense">出金</option></select>
        <div class="field-hint" data-hint-for="type">入金 / 出金</div>
      </div>
      <div class="field">
        <label for="f-label-color">色ラベル</label>
        <select id="f-label-color" name="labelColor">
          <option value="red">赤</option>
          <option value="orange">橙</option>
          <option value="yellow">黄</option>
          <option value="green">緑</option>
          <option value="blue">青</option>
          <option value="purple">紫</option>
        </select>
        <div class="field-hint" data-hint-for="labelColor">6色から選択</div>
      </div>
      <div class="field">
        <label for="f-date">予定日</label>
        <input id="f-date" name="scheduledDate" type="date" required />
        <div class="field-hint" data-hint-for="scheduledDate">選択中の年月に合わせて入力</div>
      </div>
      <div class="field">
        <label for="f-note">メモ</label>
        <input id="f-note" name="note" placeholder="任意" maxlength="140" />
        <div class="field-hint" data-hint-for="note">0-140文字</div>
      </div>
      <div class="field">
        <label for="f-cf-category">CF区分</label>
        <select id="f-cf-category" name="cfCategory">
          ${renderCfCategoryOptions('', 'income')}
        </select>
        <div class="field-hint" data-hint-for="cfCategory">未設定可。後から一覧で修正できます</div>
      </div>
      <div class="field">
        <label for="f-customer-name">顧客名</label>
        <input id="f-customer-name" name="customerName" placeholder="任意" maxlength="80" />
        <div class="field-hint" data-hint-for="customerName">0-80文字</div>
      </div>
      <div class="field">
        <label for="f-staff-name">担当社員名</label>
        <input id="f-staff-name" name="staffName" placeholder="任意" maxlength="80" />
        <div class="field-hint" data-hint-for="staffName">0-80文字</div>
      </div>
      <div class="field">
        <label>&nbsp;</label>
        <button id="submit-btn" class="primary" type="submit">追加</button>
        <div class="field-hint">Enter で追加</div>
      </div>
    </form>
  </section>

  <section class="panel">
    <div class="topline">
      <strong>予定一覧（年単位）</strong>
      <span class="muted">選択中の年の予定を表示します。上/下/先頭/末尾で移動し、表示順の累計を再計算します。</span>
      <div style="display:flex; gap:8px; align-items:center;">
        <button id="sort-by-date" class="section-toggle" type="button">日付順</button>
        <button id="toggle-list" class="section-toggle" type="button">折りたたむ</button>
      </div>
    </div>
    <div class="toolbar" style="margin-bottom:10px;">
      <input id="list-filter-keyword" type="search" placeholder="件名・メモ・口座名・顧客名・担当社員名で検索" style="min-width:320px;" />
      <select id="list-filter-month" aria-label="月絞り込み">
        <option value="all">月: すべて</option>
      </select>
      <select id="list-filter-type" aria-label="区分絞り込み">
        <option value="all">区分: すべて</option>
        <option value="income">区分: 入金</option>
        <option value="expense">区分: 出金</option>
      </select>
      <select id="list-filter-completed" aria-label="完了絞り込み">
        <option value="all">完了: すべて</option>
        <option value="open">完了: 未完了のみ</option>
        <option value="done">完了: 完了のみ</option>
      </select>
      <select id="list-filter-label" aria-label="ラベル絞り込み">
        <option value="all">ラベル: すべて</option>
        <option value="red">ラベル: 赤</option>
        <option value="orange">ラベル: 橙</option>
        <option value="yellow">ラベル: 黄</option>
        <option value="green">ラベル: 緑</option>
        <option value="blue">ラベル: 青</option>
        <option value="purple">ラベル: 紫</option>
      </select>
      <button id="list-filter-reset" type="button">絞り込み解除</button>
      <button id="export-csv" class="secondary" type="button">CSV出力</button>
      <input id="cashflow-csv-file" type="file" accept=".csv,text/csv" style="display:none" />
      <button id="import-cashflow-csv" class="secondary" type="button">CSV入力</button>
      <button id="csv-help-trigger" class="help-icon" type="button" title="CSV入力規則を表示">ⓘ</button>
      <span id="list-filter-caption" class="muted"></span>
    </div>
    <div class="column-toolbar" aria-label="予定一覧の列表示切り替え">
      <span class="muted">列の表示</span>
      <div class="column-toggle-group">
        <button type="button" class="column-toggle" data-list-col-toggle="label">ラベル</button>
        <button type="button" class="column-toggle" data-list-col-toggle="cf_category">CF区分</button>
        <button type="button" class="column-toggle" data-list-col-toggle="note">メモ</button>
        <button type="button" class="column-toggle" data-list-col-toggle="actual_date">入出金日</button>
        <button type="button" class="column-toggle" data-list-col-toggle="customer_name">顧客名</button>
        <button type="button" class="column-toggle" data-list-col-toggle="staff_name">担当</button>
        <button type="button" class="column-toggle" data-list-col-toggle="running">残高</button>
        <button type="button" class="column-toggle" data-list-col-toggle="actions">操作</button>
      </div>
      <button id="list-columns-collapse" type="button" class="secondary">詳細を折りたたむ</button>
      <button id="list-columns-reset" type="button" class="secondary">すべて表示</button>
    </div>
    <div class="bulk-bar">
      <button id="bulk-select-visible" type="button">表示中を選択</button>
      <button id="bulk-clear-selection" type="button">選択解除</button>
      <button id="bulk-edit-date" type="button">一括で日付変更</button>
      <button id="bulk-edit-actual-date" type="button">一括で確定日変更</button>
      <button id="bulk-complete" type="button">一括で完了</button>
      <button id="bulk-uncomplete" type="button">一括で未完了</button>
      <span id="bulk-selection-caption" class="muted">選択 0 件</span>
    </div>
    <div id="list-section-body" class="table-wrap">
      <table>
        <thead><tr><th data-list-col="toggle"></th><th data-list-col="index">#</th><th data-list-col="label">ラベル</th><th data-list-col="scheduled_date">予定日</th><th data-list-col="type">区分</th><th data-list-col="cf_category">CF区分</th><th data-list-col="title">件名</th><th data-list-col="amount">金額</th><th data-list-col="note">メモ</th><th data-list-col="actual_date">入出金日</th><th data-list-col="customer_name">顧客名</th><th data-list-col="staff_name">担当</th><th data-list-col="running">残高</th><th data-list-col="actions">操作</th><th data-list-col="select">選択</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </section>
</main>

<div id="csv-help-modal" class="modal-overlay">
  <div class="modal-box">
    <span id="csv-help-close" class="modal-close">&times;</span>
    <h3 style="margin-top:0;">CSV入力の記述規則について</h3>
    <p style="font-size:13px; color:var(--muted); margin-bottom:12px;">
      インポートするCSVファイル（Cashflow Managerから出力したCSV形式）は、以下の記述ルールに従ってデータを作成してください。
    </p>
    <div class="table-wrap" style="max-height: 50vh; overflow-y: auto;">
      <table style="width:100%; border-collapse:collapse; font-size:12px; min-width: 500px;">
        <thead>
          <tr style="background:#f5f8fb; color:#334e68; font-weight:700;">
            <th style="padding:8px; border-bottom:2px solid var(--line);">項目名</th>
            <th style="padding:8px; border-bottom:2px solid var(--line);">必須</th>
            <th style="padding:8px; border-bottom:2px solid var(--line);">ルール・指定形式</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>ID</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--muted);">任意</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);">既存の予定を上書き修正する場合はIDを指定します。<br>新規に予定を追加する場合は空欄にしてください。<br><small style="color:var(--expense);">※存在しないIDを指定するとエラーになります。</small></td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>予定日</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--expense); font-weight:700;">必須</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><code>YYYY-MM-DD</code> または <code>YYYY/MM/DD</code> 形式で入力してください。</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>区分</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--expense); font-weight:700;">必須</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><code>入金</code> または <code>出金</code> を指定してください。</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>CF区分</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--muted);">任意</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);">資金繰り表に反映する区分です。<code>入金</code>/<code>出金</code> に応じた候補から選びます。空欄のままでも入力できます。</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>件名</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--expense); font-weight:700;">必須</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);">120文字以内で入力してください。</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>金額</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--expense); font-weight:700;">必須</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);">1以上の半角整数で入力してください（カンマ区切り可）。</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>メモ</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--muted);">任意</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);">140文字以内で入力してください。</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>入出金日</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--muted);">任意</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><code>YYYY-MM-DD</code> または <code>YYYY/MM/DD</code> 形式で入力してください。</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>顧客名</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--muted);">任意</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);">80文字以内で入力してください。</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>担当社員名</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--muted);">任意</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);">80文字以内で入力してください。</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>完了状態</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--muted);">任意</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><code>完了</code> または <code>未完了</code> を指定してください（空欄は未完了）。</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>ラベル</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--muted);">任意</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);">以下のいずれかの英語（小文字）で入力してください：<br><code>red</code> (赤), <code>orange</code> (橙), <code>yellow</code> (黄), <code>green</code> (緑), <code>blue</code> (青), <code>purple</code> (紫)</td>
          </tr>
          <tr>
            <td style="padding:8px; border-bottom:1px solid var(--line);"><strong>管理番号</strong></td>
            <td style="padding:8px; border-bottom:1px solid var(--line); color:var(--muted);">任意</td>
            <td style="padding:8px; border-bottom:1px solid var(--line);">80文字以内で入力してください。</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div style="margin-top:16px; text-align:right;">
      <button id="csv-help-ok" type="button" class="primary" style="padding:8px 20px; font-size:13px; cursor:pointer;">閉じる</button>
    </div>
  </div>
</div>

<div id="rakuraku-diff-modal" class="modal-overlay">
  <div class="modal-box" style="max-width: 900px; width: 95%;">
    <span id="rakuraku-diff-close" class="modal-close">&times;</span>
    <h3 style="margin-top:0;">楽楽販売CSVインポート確認</h3>
    <p style="font-size:13px; color:var(--muted); margin-bottom:12px;">
      既存データとの差分を検出しました。上書き取り込みする予定にチェックを入れて「インポート実行」をクリックしてください。<br>
      新規データ（<span id="rakuraku-new-count">0</span>件）は自動的にインポートされます。重複データは自動的にスキップされます。
    </p>
    <div class="table-wrap" style="max-height: 50vh; overflow-y: auto;">
      <table class="diff-table">
        <thead>
          <tr style="background:#f5f8fb; color:#334e68; font-weight:700;">
            <th style="width: 50px; text-align: center;"><input type="checkbox" id="rakuraku-diff-select-all" checked /></th>
            <th>管理番号</th>
            <th>区分</th>
            <th>件名 (DB &rarr; CSV)</th>
            <th>金額 (DB &rarr; CSV)</th>
            <th>予定日 (DB &rarr; CSV)</th>
            <th>顧客名 (DB &rarr; CSV)</th>
          </tr>
        </thead>
        <tbody id="rakuraku-diff-rows">
        </tbody>
      </table>
    </div>
    <div style="margin-top:16px; display: flex; justify-content: space-between; align-items: center;">
      <span id="rakuraku-diff-summary" style="font-size:13px; font-weight:bold;">新規: 0件 / 差分更新: 0件</span>
      <div style="display:flex; gap:8px;">
        <button id="rakuraku-diff-cancel" type="button" class="secondary" style="padding:8px 20px; font-size:13px; cursor:pointer;">キャンセル</button>
        <button id="rakuraku-diff-submit" type="button" class="primary" style="padding:8px 20px; font-size:13px; cursor:pointer;">インポート実行</button>
      </div>
    </div>
  </div>
</div>

<script>
  const yearInput = document.getElementById('year');
  const fixedMonth = String(new Date().getMonth() + 1).padStart(2, '0');
  const monthCaption = document.getElementById('month-caption');
  const rowsEl = document.getElementById('rows');
  const form = document.getElementById('entry-form');
  const statusBanner = document.getElementById('status-banner');
  const submitBtn = document.getElementById('submit-btn');
  const entryTypeEl = document.getElementById('f-type');
  const entryCfCategoryEl = document.getElementById('f-cf-category');
  const sumIncomeEl = document.getElementById('sum-income');
  const sumExpenseEl = document.getElementById('sum-expense');
  const sumBalanceEl = document.getElementById('sum-balance');
  const balanceAlertEl = document.getElementById('balance-alert');
  const annualExpenseRowsEl = document.getElementById('annual-expense-rows');
  const loadSampleBtn = document.getElementById('load-sample');
  const clearSampleBtn = document.getElementById('clear-sample');
  const clearAllEntriesBtn = document.getElementById('clear-all-entries');
  const rakurakuCsvFileInput = document.getElementById('rakuraku-csv-file');
  const importRakurakuCsvBtn = document.getElementById('import-rakuraku-csv');
  const cashflowCsvFileInput = document.getElementById('cashflow-csv-file');
  const importCashflowCsvBtn = document.getElementById('import-cashflow-csv');
  const csvHelpTrigger = document.getElementById('csv-help-trigger');
  const csvHelpModal = document.getElementById('csv-help-modal');
  const csvHelpClose = document.getElementById('csv-help-close');
  const csvHelpOk = document.getElementById('csv-help-ok');

  const rakurakuDiffModal = document.getElementById('rakuraku-diff-modal');
  const rakurakuDiffRows = document.getElementById('rakuraku-diff-rows');
  const rakurakuNewCount = document.getElementById('rakuraku-new-count');
  const rakurakuDiffSummary = document.getElementById('rakuraku-diff-summary');
  const rakurakuDiffSelectAll = document.getElementById('rakuraku-diff-select-all');

  const toggleAnnualBtn = document.getElementById('toggle-annual');
  const toggleListBtn = document.getElementById('toggle-list');
  const sortByDateBtn = document.getElementById('sort-by-date');
  const annualSectionBody = document.getElementById('annual-section-body');
  const listSectionBody = document.getElementById('list-section-body');
  const listFilterKeywordEl = document.getElementById('list-filter-keyword');
  const listFilterMonthEl = document.getElementById('list-filter-month');
  const listFilterTypeEl = document.getElementById('list-filter-type');
  const listFilterCompletedEl = document.getElementById('list-filter-completed');
  const listFilterLabelEl = document.getElementById('list-filter-label');
    const listFilterResetBtn = document.getElementById('list-filter-reset');
    const exportCsvBtn = document.getElementById('export-csv');
    const listFilterCaptionEl = document.getElementById('list-filter-caption');
    const listColumnsCollapseBtn = document.getElementById('list-columns-collapse');
    const listColumnsResetBtn = document.getElementById('list-columns-reset');
    const bulkSelectVisibleBtn = document.getElementById('bulk-select-visible');
  const bulkClearSelectionBtn = document.getElementById('bulk-clear-selection');
  const bulkEditDateBtn = document.getElementById('bulk-edit-date');
  const bulkEditActualDateBtn = document.getElementById('bulk-edit-actual-date');
  const bulkCompleteBtn = document.getElementById('bulk-complete');
  const bulkUncompleteBtn = document.getElementById('bulk-uncomplete');
  const bulkSelectionCaptionEl = document.getElementById('bulk-selection-caption');

  const fmt = new Intl.NumberFormat('ja-JP');
  let entries = [];
  let savingReorder = false;
  let openingBalance = 0;
  const selectedEntryIds = new Set();
  const expandedMgmtIds = new Set();
  let lastCheckedVisibleIndex = -1;

  const now = new Date();
  initPeriodSelectors(now);
  syncFormDateWithMonth();
  syncEntryCfCategoryOptions();
  setMonthCaption();

  function initPeriodSelectors(d) {
    const y = d.getFullYear();
    yearInput.innerHTML = Array.from({ length: 7 }, (_, i) => y - 3 + i).map((v) => '<option value=\"' + v + '\">' + v + '年</option>').join('');
    yearInput.value = String(y);
  }

  function selectedMonth() {
    return String(yearInput.value) + '-' + fixedMonth;
  }

  function showBanner(el, type, message) {
    el.className = 'banner show ' + type;
    el.textContent = message;
  }

  function hideBanner(el) {
    el.className = 'banner';
    el.textContent = '';
  }

  function safeJsonParse(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function buildApiErrorMessage(payload, fallbackText, defaultMessage) {
    if (payload && typeof payload === 'object') {
      const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode.trim() : '';
      const message = typeof payload.message === 'string'
        ? payload.message.trim()
        : (typeof payload.error === 'string' ? payload.error.trim() : '');
      if (errorCode && message) return errorCode + ': ' + message;
      if (errorCode) return errorCode;
      if (message) return message;
    }
    const plain = (fallbackText || '').trim();
    return plain || defaultMessage;
  }

  function setMonthCaption() {
    monthCaption.textContent = yearInput.value + '年の予定を表示中';
  }

  function syncFormDateWithMonth() {
    const dateInput = form.elements.scheduledDate;
    if (!dateInput) return;
    const month = selectedMonth();
    if (!month) return;
    if (!dateInput.value || dateInput.value.slice(0, 7) !== month) {
      dateInput.value = month + '-01';
    }
  }

  function getCfCategoryOptionsByType(type) {
    return type === 'expense'
      ? ${JSON.stringify(['', ...CF_EXPENSE_CATEGORIES])}
      : ${JSON.stringify(['', ...CF_INCOME_CATEGORIES])};
  }

  function buildEntryCfCategoryOptionsHtml(selected, type) {
    return getCfCategoryOptionsByType(type).map((category) => {
      const label = category === '' ? '未設定' : category;
      return '<option value="' + escapeHtml(category) + '"' + (category === selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');
  }

  function syncEntryCfCategoryOptions() {
    if (!entryTypeEl || !entryCfCategoryEl) return;
    const type = String(entryTypeEl.value || 'income');
    const selected = String(entryCfCategoryEl.value || '');
    const options = getCfCategoryOptionsByType(type);
    const nextSelected = options.includes(selected) ? selected : '';
    entryCfCategoryEl.innerHTML = buildEntryCfCategoryOptionsHtml(nextSelected, type);
    entryCfCategoryEl.value = nextSelected;
  }

  const LIST_COLUMN_STORAGE_KEY = 'cashflow-list-hidden-columns-v1';
  const LIST_COLUMN_HIDE_PRESET = ['label', 'cf_category', 'note', 'actual_date', 'customer_name', 'staff_name', 'running', 'actions'];
  const LIST_COLUMN_LABELS = new Map([
    ['label', 'ラベル'],
    ['cf_category', 'CF区分'],
    ['note', 'メモ'],
    ['actual_date', '入出金日'],
    ['customer_name', '顧客名'],
    ['staff_name', '担当'],
    ['running', '残高'],
    ['actions', '操作']
  ]);
  let hiddenListColumns = loadHiddenListColumns();

  function loadHiddenListColumns() {
    try {
      const raw = localStorage.getItem(LIST_COLUMN_STORAGE_KEY);
      if (!raw) return new Set(LIST_COLUMN_HIDE_PRESET);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((v) => typeof v === 'string' && LIST_COLUMN_LABELS.has(v)));
    } catch (_) {
      return new Set(LIST_COLUMN_HIDE_PRESET);
    }
  }

  function saveHiddenListColumns() {
    try {
      localStorage.setItem(LIST_COLUMN_STORAGE_KEY, JSON.stringify([...hiddenListColumns]));
    } catch (_) {
      // localStorage が使えない環境では保存を諦める
    }
  }

  function setListColumnHidden(key, hidden) {
    if (!LIST_COLUMN_LABELS.has(key)) return;
    if (hidden) hiddenListColumns.add(key);
    else hiddenListColumns.delete(key);
    saveHiddenListColumns();
    syncListColumnToggleUi();
    applyListColumnVisibility();
  }

  function collapseDetailColumns() {
    hiddenListColumns = new Set(LIST_COLUMN_HIDE_PRESET);
    saveHiddenListColumns();
    syncListColumnToggleUi();
    applyListColumnVisibility();
  }

  function showAllListColumns() {
    hiddenListColumns = new Set();
    saveHiddenListColumns();
    syncListColumnToggleUi();
    applyListColumnVisibility();
  }

  function syncListColumnToggleUi() {
    document.querySelectorAll('[data-list-col-toggle]').forEach((btn) => {
      if (!(btn instanceof HTMLButtonElement)) return;
      const key = String(btn.dataset.listColToggle || '');
      const label = LIST_COLUMN_LABELS.get(key) || key;
      const hidden = hiddenListColumns.has(key);
      btn.classList.toggle('is-hidden', hidden);
      btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
      btn.textContent = label;
      btn.title = hidden ? label + 'を表示' : label + 'を非表示';
    });
    if (listColumnsResetBtn instanceof HTMLButtonElement) {
      listColumnsResetBtn.disabled = hiddenListColumns.size === 0;
    }
    if (listColumnsCollapseBtn instanceof HTMLButtonElement) {
      listColumnsCollapseBtn.disabled = LIST_COLUMN_HIDE_PRESET.every((key) => hiddenListColumns.has(key));
    }
  }

  function applyListColumnVisibility() {
    const table = document.getElementById('list-section-body');
    if (!table) return;
    table.querySelectorAll('[data-list-col]').forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const key = String(el.dataset.listCol || '');
      if (!key || !LIST_COLUMN_LABELS.has(key)) return;
      el.classList.toggle('is-hidden-col', hiddenListColumns.has(key));
    });
    syncListColumnToggleUi();
  }

  function validatePayload(payload) {
    const hints = new Map(Array.from(form.querySelectorAll('.field-hint')).map((el) => [el.dataset.hintFor, el]));
    for (const el of hints.values()) el.classList.remove('error');

    if (!payload.title || payload.title.trim().length < 1 || payload.title.trim().length > 80) {
      const hint = hints.get('title'); if (hint) hint.classList.add('error');
      return '件名は1〜80文字で入力してください。';
    }
    if (!Number.isInteger(payload.amount) || payload.amount <= 0) {
      const hint = hints.get('amount'); if (hint) hint.classList.add('error');
      return '金額は1円以上の整数で入力してください。';
    }
    if (!payload.scheduledDate || !normalizeDate(payload.scheduledDate)) {
      const hint = hints.get('scheduledDate'); if (hint) hint.classList.add('error');
      return '予定日を正しく入力してください。';
    }
    if (payload.note.length > 140) {
      const hint = hints.get('note'); if (hint) hint.classList.add('error');
      return 'メモは140文字以内で入力してください。';
    }
    const allowedAccounts = new Set(['', '三井住友口座', '和気口座', '那須口座']);
    const allowedColors = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
    const allowedCfCategories = new Set(getCfCategoryOptionsByType(payload.type || 'income'));
    if (!allowedAccounts.has(payload.accountName)) {
      const hint = hints.get('accountName'); if (hint) hint.classList.add('error');
      return '口座名はプルダウンから選択してください。';
    }
    if (payload.accountName.length > 80) {
      const hint = hints.get('accountName'); if (hint) hint.classList.add('error');
      return '口座名は80文字以内で入力してください。';
    }
    if (payload.customerName.length > 80) {
      const hint = hints.get('customerName'); if (hint) hint.classList.add('error');
      return '顧客名は80文字以内で入力してください。';
    }
    if (payload.staffName.length > 80) {
      const hint = hints.get('staffName'); if (hint) hint.classList.add('error');
      return '担当社員名は80文字以内で入力してください。';
    }
    if (!allowedColors.has(payload.labelColor)) {
      const hint = hints.get('labelColor'); if (hint) hint.classList.add('error');
      return '色ラベルを選択してください。';
    }
    if (!allowedCfCategories.has(payload.cfCategory || '')) {
      const hint = hints.get('cfCategory'); if (hint) hint.classList.add('error');
      return 'CF区分を正しく選択してください。';
    }
    return '';
  }

  function buildCfCategoryOptionsHtml(selected, type) {
    return getCfCategoryOptionsByType(type || 'income').map((category) => {
      const label = category === '' ? 'CF:未設定' : 'CF:' + category;
      return '<option value="' + escapeHtml(category) + '"' + (category === selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');
  }

  function updateSummary(summary) {
    const income = Number(summary.income || 0);
    const expense = Number(summary.expense || 0);
    const balance = Number(summary.balance || 0);

    sumIncomeEl.textContent = fmt.format(income);
    sumExpenseEl.textContent = fmt.format(expense);
    sumBalanceEl.textContent = (balance > 0 ? '+' : '') + fmt.format(balance);
    sumBalanceEl.classList.remove('plus', 'minus');
    sumBalanceEl.classList.add(balance < 0 ? 'minus' : 'plus');
    if (balance < 0) {
      balanceAlertEl.textContent = '警告: 今月の差引がマイナスです。資金繰りを確認してください。';
      balanceAlertEl.classList.add('show');
    } else {
      balanceAlertEl.textContent = '';
      balanceAlertEl.classList.remove('show');
    }
  }

  function updateSelectedMonthAlert() {
    const month = selectedMonth();
    const monthEntries = entries.filter((e) => String(e.scheduled_date || '').slice(0, 7) === month);
    const balance = monthEntries.reduce((sum, e) => {
      const amount = Number(e.amount || 0);
      return sum + (e.type === 'income' ? amount : -amount);
    }, 0);
    const monthLabel = month.slice(5, 7);
    if (balance < 0) {
      balanceAlertEl.textContent = '警告: ' + String(Number(monthLabel)) + '月の差引がマイナスです。資金繰りを確認してください。';
      balanceAlertEl.classList.add('show');
    } else {
      balanceAlertEl.textContent = '';
      balanceAlertEl.classList.remove('show');
    }
  }

  async function loadAll() {
    const month = selectedMonth();
    const year = String(yearInput.value);

    try {
      const [summaryRes, entriesRes, openingRes] = await Promise.all([
        fetch('/api/summary?month=' + encodeURIComponent(month)),
        fetch('/api/entries?year=' + encodeURIComponent(year)),
        fetch('/api/opening-balance?month=' + encodeURIComponent(month))
      ]);
      const annualRes = await fetch('/api/annual-expense-entries?year=' + encodeURIComponent(year));

      const summary = summaryRes.ok ? await summaryRes.json() : { income: 0, expense: 0, balance: 0 };
      const entriesPayload = entriesRes.ok ? await entriesRes.json() : { entries: [] };
      const openingPayload = openingRes.ok ? await openingRes.json() : { openingBalance: 0 };
      const annualPayload = annualRes.ok ? await annualRes.json() : { entries: [] };
      entries = Array.isArray(entriesPayload.entries) ? entriesPayload.entries : [];
      openingBalance = Number(openingPayload.openingBalance || 0);
      syncMonthFilterOptions();

      updateSummary(summary);
      renderRows();
      updateSelectedMonthAlert();
      renderAnnualExpenses(Array.isArray(annualPayload.entries) ? annualPayload.entries : []);
      if (!entriesRes.ok) {
        showBanner(statusBanner, 'error', '一覧データの取得に失敗しました。再読み込みしてください。');
      } else {
        hideBanner(statusBanner);
      }
    } catch (err) {
      console.error('loadAll failed', err);
      if (entries.length === 0) {
        showBanner(statusBanner, 'error', '一覧の取得に失敗しました。通信状態を確認して再読み込みしてください。');
      } else {
        hideBanner(statusBanner);
      }
    }
  }

  function renderAnnualExpenses(rows) {
    if (rows.length === 0) {
      annualExpenseRowsEl.innerHTML = '<tr><td colspan="6" class="muted">この年のデータはありません。</td></tr>';
      return;
    }
    let annualRunning = 0;
    annualExpenseRowsEl.innerHTML = rows.map((e) => {
      const amount = Number(e.amount || 0);
      annualRunning += e.type === 'income' ? amount : -amount;
      return '<tr>' +
      '<td>' + escapeHtml(e.scheduled_date) + '</td>' +
      '<td>' + (e.type === 'income' ? '入金' : '出金') + '</td>' +
      '<td>' + escapeHtml(e.title || '') + '</td>' +
      '<td class="amount ' + e.type + '">' + (e.type === 'income' ? '+' : '-') + fmt.format(amount) + '</td>' +
      '<td>' + escapeHtml(e.note || '') + '</td>' +
      '<td class="running ' + (annualRunning < 0 ? 'minus' : 'plus') + '">' + (annualRunning > 0 ? '+' : '') + fmt.format(annualRunning) + '</td>' +
      '</tr>'
    }).join('');
  }

  function normalizeDate(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  function syncMonthFilterOptions() {
    if (!listFilterMonthEl) return;
    const previous = String(listFilterMonthEl.value || 'all');
    const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
    listFilterMonthEl.innerHTML = '<option value="all">月: すべて</option>' +
      months.map((mm) => '<option value="' + mm + '">' + Number(mm) + '月</option>').join('');
    listFilterMonthEl.value = (previous === 'all' || months.includes(previous)) ? previous : 'all';
  }

  async function pickDateWithCalendar(initialValue, allowEmpty) {
    return await new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.background = 'rgba(0,0,0,.35)';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.zIndex = '9999';

      const box = document.createElement('div');
      box.style.background = '#fff';
      box.style.border = '1px solid #d4dde7';
      box.style.borderRadius = '10px';
      box.style.padding = '14px';
      box.style.minWidth = '280px';
      box.style.boxShadow = '0 10px 28px rgba(10, 36, 64, 0.22)';

      const title = document.createElement('div');
      title.textContent = '日付を選択';
      title.style.fontWeight = '700';
      title.style.marginBottom = '8px';

      const input = document.createElement('input');
      input.type = 'date';
      input.value = normalizeDate(initialValue || '');
      input.style.width = '100%';
      input.style.marginBottom = '10px';

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '8px';
      actions.style.justifyContent = 'flex-end';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'キャンセル';

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = 'クリア';
      clearBtn.style.display = allowEmpty ? 'inline-block' : 'none';

      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.textContent = '確定';
      okBtn.className = 'primary';

      actions.appendChild(cancelBtn);
      actions.appendChild(clearBtn);
      actions.appendChild(okBtn);

      box.appendChild(title);
      box.appendChild(input);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const finish = (value) => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      };

      cancelBtn.addEventListener('click', () => finish(null));
      clearBtn.addEventListener('click', () => finish(''));
      okBtn.addEventListener('click', () => finish(normalizeDate(input.value || '')));
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) finish(null);
      });

      input.focus();
      if (typeof input.showPicker === 'function') {
        input.showPicker();
      }
    });
  }

  function getFilteredEntries() {
    const keyword = String(listFilterKeywordEl?.value || '').trim().toLowerCase();
    const monthFilter = String(listFilterMonthEl?.value || 'all');
    const typeFilter = String(listFilterTypeEl?.value || 'all');
    const completedFilter = String(listFilterCompletedEl?.value || 'all');
    const labelFilter = String(listFilterLabelEl?.value || 'all');
    return entries.filter((e) => {
      if (monthFilter !== 'all') {
        const d = String(e.scheduled_date || '');
        if (d.slice(5, 7) !== monthFilter) return false;
      }
      if (typeFilter !== 'all' && e.type !== typeFilter) return false;
      const labelColor = String(e.label_color || 'blue');
      if (labelFilter !== 'all' && labelColor !== labelFilter) return false;
      const isDone = Number(e.is_completed) === 1;
      if (completedFilter === 'open' && isDone) return false;
      if (completedFilter === 'done' && !isDone) return false;
      if (!keyword) return true;
      const haystack = [
        e.title || '',
        e.note || '',
        e.cf_category || '',
        e.account_name || '',
        e.customer_name || '',
        e.staff_name || '',
        e.scheduled_date || '',
        e.actual_transaction_date || ''
      ].join(' ').toLowerCase();
      return haystack.includes(keyword);
    });
  }

  function updateBulkSelectionCaption() {
    if (bulkSelectionCaptionEl) bulkSelectionCaptionEl.textContent = '選択 ' + String(selectedEntryIds.size) + ' 件';
  }

  function getSelectedIdsInCurrentEntries() {
    const validIds = new Set(entries.map((e) => Number(e.id)));
    const fromMemory = [...selectedEntryIds].filter((id) => validIds.has(id));
    if (fromMemory.length > 0) return fromMemory;
    const fromDom = Array.from(rowsEl.querySelectorAll('input[type="checkbox"][data-select-id]:checked'))
      .map((el) => Number((el instanceof HTMLInputElement ? el.dataset.selectId : '0') || '0'))
      .filter((id) => Number.isInteger(id) && id > 0 && validIds.has(id));
    return [...new Set(fromDom)];
  }

  function renderRows() {
    if (entries.length === 0) {
      rowsEl.innerHTML = '<tr><td colspan="15" class="muted">データがありません。上のフォームから予定を追加してください。</td></tr>';
      listFilterCaptionEl.textContent = '';
      updateBulkSelectionCaption();
      return;
    }

    const filtered = getFilteredEntries();

    listFilterCaptionEl.textContent = filtered.length === entries.length
      ? '全件表示'
      : String(filtered.length) + ' / ' + String(entries.length) + '件を表示';

    if (filtered.length === 0) {
      rowsEl.innerHTML = '<tr><td colspan="15" class="muted">絞り込み条件に一致する予定はありません。</td></tr>';
      updateBulkSelectionCaption();
      return;
    }

    const runningById = new Map();
    let running = openingBalance;
    for (const entry of filtered) {
      const amount = Number(entry.amount || 0);
      running += entry.type === 'income' ? amount : -amount;
      runningById.set(entry.id, running);
    }

    rowsEl.innerHTML = filtered.map((e, idx) => {
      const amount = Number(e.amount);
      const entryRunning = Number(runningById.get(e.id) || 0);
      const runningClass = entryRunning < 0 ? 'minus' : 'plus';
      const rowClass = Number(e.is_completed) === 1 ? ' class="completed"' : '';
      const hasMgmt = String(e.import_management_no || '').trim() !== '';
      const expanded = expandedMgmtIds.has(Number(e.id));
      const toggleLabel = expanded ? '−' : '+';
      const toggleButton = hasMgmt
        ? '<button type="button" class="toggle-mgmt" data-togglemgmt="1" data-id="' + e.id + '">' + toggleLabel + '</button>'
        : '';
      const detailRow = hasMgmt && expanded
        ? '<tr class="detail-row"><td></td><td colspan="14">入出金管理No: ' + escapeHtml(String(e.import_management_no || '')) + '</td></tr>'
        : '';

      return '<tr' + rowClass + '>' +
        '<td class="toggle-cell" data-list-col="toggle">' + toggleButton + '</td>' +
        '<td data-list-col="index">' + (idx + 1) + '</td>' +
        '<td data-list-col="label">' +
          '<span class="label-dot label-' + escapeHtml(String(e.label_color || 'blue')) + '"></span>' +
        '</td>' +
        '<td data-list-col="scheduled_date">' + escapeHtml(e.scheduled_date) + '</td>' +
        '<td data-list-col="type">' + (e.type === 'income' ? '入金' : '出金') + '</td>' +
        '<td data-list-col="cf_category">' + escapeHtml(e.cf_category || '未設定') + '</td>' +
        '<td data-list-col="title">' + escapeHtml(e.title) + '</td>' +
        '<td class="amount ' + e.type + '" data-list-col="amount">' + (e.type === 'income' ? '+' : '-') + fmt.format(amount) + '</td>' +
        '<td data-list-col="note">' + escapeHtml(e.note || '') + '</td>' +
        '<td data-list-col="actual_date">' + escapeHtml(e.actual_transaction_date || '') + '</td>' +
        '<td data-list-col="customer_name">' + escapeHtml(e.customer_name || '') + '</td>' +
        '<td data-list-col="staff_name">' + escapeHtml(e.staff_name || '') + '</td>' +
        '<td class="running ' + runningClass + '" data-list-col="running">' + (entryRunning > 0 ? '+' : '') + fmt.format(entryRunning) + '</td>' +
        '<td class="actions" data-list-col="actions">' +
          '<div class="action-row">' +
            '<button type="button" data-move="top" data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '') + '>先頭</button>' +
            '<button type="button" data-move="up" data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '') + '>上</button>' +
            '<button type="button" data-move="down" data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '') + '>下</button>' +
            '<button type="button" data-move="bottom" data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '') + '>末尾</button>' +
            '<button type="button" data-delete="1" data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '') + '>削除</button>' +
          '</div>' +
          '<div class="action-row">' +
            '<button type="button" data-editdate="1" data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '') + '>日付変更</button>' +
            '<button type="button" data-editactualdate="1" data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '') + '>確定日</button>' +
            '<button type="button" data-complete="1" data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '') + '>' + (Number(e.is_completed) === 1 ? '完了済み' : '完了') + '</button>' +
            '<select data-editcfcategory="1" data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '') + '>' +
            buildCfCategoryOptionsHtml(String(e.cf_category || ''), e.type) +
            '</select>' +
            '<select data-editcolor="1" data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '') + '>' +
            '<option value="red"' + (e.label_color === 'red' ? ' selected' : '') + '>色:赤</option>' +
            '<option value="orange"' + (e.label_color === 'orange' ? ' selected' : '') + '>色:橙</option>' +
            '<option value="yellow"' + (e.label_color === 'yellow' ? ' selected' : '') + '>色:黄</option>' +
            '<option value="green"' + (e.label_color === 'green' ? ' selected' : '') + '>色:緑</option>' +
            '<option value="blue"' + ((e.label_color === 'blue' || !e.label_color) ? ' selected' : '') + '>色:青</option>' +
            '<option value="purple"' + (e.label_color === 'purple' ? ' selected' : '') + '>色:紫</option>' +
            '</select>' +
          '</div>' +
        '</td>' +
        '<td class="select-cell" data-list-col="select"><input type="checkbox" data-select-id="' + e.id + '"' + (selectedEntryIds.has(Number(e.id)) ? ' checked' : '') + ' /></td>' +
      '</tr>' + detailRow;
    }).join('');
    applyListColumnVisibility();
    updateBulkSelectionCaption();
  }

  async function bulkUpdate(action, payload, successMessage) {
    const ids = getSelectedIdsInCurrentEntries();
    if (ids.length === 0) {
      showBanner(statusBanner, 'warn', '先に対象行をチェックしてください。');
      return;
    }
    try {
      const res = await fetch('/api/entries/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, action, ...payload })
      });
      if (!res.ok) {
        const rawBody = await res.text();
        const parsed = safeJsonParse(rawBody) || {};
        showBanner(statusBanner, 'error', buildApiErrorMessage(parsed, rawBody, '一括更新に失敗しました。'));
        return;
      }
      showBanner(statusBanner, 'ok', successMessage.replace('{count}', String(ids.length)));
      selectedEntryIds.clear();
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', '一括更新中に通信エラーが発生しました。');
    }
  }

  function moveEntry(index, dir) {
    const updated = [...entries];
    if (dir === 'up' && index > 0) {
      [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    }
    if (dir === 'down' && index < updated.length - 1) {
      [updated[index + 1], updated[index]] = [updated[index], updated[index + 1]];
    }
    if (dir === 'top' && index > 0) {
      const [item] = updated.splice(index, 1);
      updated.unshift(item);
    }
    if (dir === 'bottom' && index < updated.length - 1) {
      const [item] = updated.splice(index, 1);
      updated.push(item);
    }
    return updated;
  }

  async function persistReorder() {
    const res = await fetch('/api/entries/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ year: String(yearInput.value), orderedIds: entries.map((e) => e.id) })
    });

    if (!res.ok) {
      throw new Error('reorder failed');
    }
  }

  async function reorder(id, dir) {
    if (savingReorder) return;
    const index = entries.findIndex((e) => e.id === id);
    if (index < 0) return;

    const moved = moveEntry(index, dir);
    if (moved === entries) return;

    entries = moved;
    renderRows();

    savingReorder = true;
    renderRows();
    try {
      await persistReorder();
      showBanner(statusBanner, 'ok', '並び順を保存しました。');
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', '並び順の保存に失敗しました。最新状態を再読み込みします。');
      await loadAll();
    } finally {
      savingReorder = false;
      renderRows();
    }
  }

  async function reorderByDate() {
    if (savingReorder || entries.length < 2) return;
    const sorted = [...entries].sort((a, b) => {
      const aDate = String(a.scheduled_date || '');
      const bDate = String(b.scheduled_date || '');
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return Number(a.id) - Number(b.id);
    });

    if (sorted.every((item, idx) => item.id === entries[idx]?.id)) {
      showBanner(statusBanner, 'warn', 'すでに日付順です。');
      return;
    }

    entries = sorted;
    savingReorder = true;
    renderRows();
    sortByDateBtn.disabled = true;
    try {
      await persistReorder();
      showBanner(statusBanner, 'ok', '日付順で並べ替えました。');
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', '日付順の保存に失敗しました。最新状態を再読み込みします。');
      await loadAll();
    } finally {
      savingReorder = false;
      sortByDateBtn.disabled = false;
      renderRows();
    }
  }

  async function deleteEntry(id) {
    const target = entries.find((e) => e.id === id);
    if (!target) return;
    const confirmed = window.confirm('この予定を削除しますか？\\n' + target.scheduled_date + ' / ' + target.title);
    if (!confirmed) return;

    try {
      const res = await fetch('/api/entries/' + encodeURIComponent(String(id)), { method: 'DELETE' });
      if (!res.ok) {
        showBanner(statusBanner, 'error', '削除に失敗しました。権限または最新状態を確認してください。');
        return;
      }
      showBanner(statusBanner, 'ok', '予定を削除しました。');
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', '削除処理中に通信エラーが発生しました。');
    }
  }

  async function completeEntry(id) {
    const target = entries.find((e) => e.id === id);
    if (!target) return;
    try {
      const res = await fetch('/api/entries/' + encodeURIComponent(String(id)) + '/complete', { method: 'POST' });
      if (!res.ok) {
        showBanner(statusBanner, 'error', '完了更新に失敗しました。');
        return;
      }
      showBanner(statusBanner, 'ok', Number(target.is_completed) === 1 ? '完了を解除しました。' : '予定を完了にしました。');
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', '完了処理中に通信エラーが発生しました。');
    }
  }

  async function editEntryDate(id) {
    const target = entries.find((e) => e.id === id);
    if (!target) return;
    const normalized = await pickDateWithCalendar(String(target.scheduled_date || ''), false);
    if (normalized == null) return;
    if (!normalized) {
      showBanner(statusBanner, 'warn', '日付を選択してください。');
      return;
    }
    if (normalized === target.scheduled_date) return;

    try {
      const res = await fetch('/api/entries/' + encodeURIComponent(String(id)) + '/date', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scheduledDate: normalized })
      });
      if (!res.ok) {
        showBanner(statusBanner, 'error', '日付の更新に失敗しました。');
        return;
      }
      showBanner(statusBanner, 'ok', '予定日を更新しました。');
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', '日付更新中に通信エラーが発生しました。');
    }
  }

  async function editEntryActualDate(id) {
    const target = entries.find((e) => e.id === id);
    if (!target) return;
    const normalized = await pickDateWithCalendar(String(target.actual_transaction_date || ''), true);
    if (normalized == null) return;

    try {
      const res = await fetch('/api/entries/' + encodeURIComponent(String(id)) + '/actual-date', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actualTransactionDate: normalized })
      });
      if (!res.ok) {
        showBanner(statusBanner, 'error', '実際入出金日の更新に失敗しました。');
        return;
      }
      showBanner(statusBanner, 'ok', '実際入出金日を更新しました。');
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', '実際入出金日の更新中に通信エラーが発生しました。');
    }
  }

  rowsEl.addEventListener('click', (ev) => {
    const checkbox = ev.target instanceof Element
      ? ev.target.closest('input[type="checkbox"][data-select-id]')
      : null;
    if (checkbox instanceof HTMLInputElement) {
      const visibleCheckboxes = Array.from(rowsEl.querySelectorAll('input[type="checkbox"][data-select-id]'));
      const index = visibleCheckboxes.indexOf(checkbox);
      if (index < 0) return;
      const prevIndex = lastCheckedVisibleIndex;
      lastCheckedVisibleIndex = index;
      if (ev.shiftKey && prevIndex >= 0) {
        window.requestAnimationFrame(() => {
          const nextChecked = checkbox.checked;
          const start = Math.min(prevIndex, index);
          const end = Math.max(prevIndex, index);
          for (let i = start; i <= end; i += 1) {
            const input = visibleCheckboxes[i];
            if (!(input instanceof HTMLInputElement)) continue;
            input.checked = nextChecked;
            const id = Number(input.dataset.selectId || '0');
            if (nextChecked) selectedEntryIds.add(id);
            else selectedEntryIds.delete(id);
          }
          updateBulkSelectionCaption();
        });
      }
      return;
    }

    const btn = ev.target.closest('button[data-id]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.togglemgmt) {
      if (expandedMgmtIds.has(id)) expandedMgmtIds.delete(id);
      else expandedMgmtIds.add(id);
      renderRows();
      return;
    }
    if (btn.dataset.delete) {
      deleteEntry(id);
      return;
    }
    if (btn.dataset.complete) {
      completeEntry(id);
      return;
    }
    if (btn.dataset.editdate) {
      editEntryDate(id);
      return;
    }
    if (btn.dataset.editactualdate) {
      editEntryActualDate(id);
      return;
    }
    const dir = String(btn.dataset.move || '');
    reorder(id, dir);
  });

  rowsEl.addEventListener('change', async (ev) => {
    const target = ev.target;
    if (target instanceof HTMLInputElement && target.type === 'checkbox' && target.dataset.selectId) {
      const id = Number(target.dataset.selectId || '0');
      if (target.checked) selectedEntryIds.add(id);
      else selectedEntryIds.delete(id);
      updateBulkSelectionCaption();
      return;
    }
    if (!(target instanceof HTMLSelectElement)) return;
    if (target.dataset.editcfcategory && target.dataset.id) {
      const id = Number(target.dataset.id);
      const cfCategory = String(target.value || '').trim();
      try {
        const res = await fetch('/api/entries/' + encodeURIComponent(String(id)) + '/cf-category', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cfCategory })
        });
        if (!res.ok) {
          showBanner(statusBanner, 'error', 'CF区分の更新に失敗しました。');
          await loadAll();
          return;
        }
        showBanner(statusBanner, 'ok', 'CF区分を更新しました。');
        await loadAll();
      } catch (_) {
        showBanner(statusBanner, 'error', 'CF区分更新中に通信エラーが発生しました。');
        await loadAll();
      }
      return;
    }
    if (!target.dataset.editcolor || !target.dataset.id) return;
    const id = Number(target.dataset.id);
    const labelColor = String(target.value || '').trim();
    try {
      const res = await fetch('/api/entries/' + encodeURIComponent(String(id)) + '/color', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labelColor })
      });
      if (!res.ok) {
        showBanner(statusBanner, 'error', '色ラベルの更新に失敗しました。');
        await loadAll();
        return;
      }
      showBanner(statusBanner, 'ok', '色ラベルを更新しました。');
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', '色ラベル更新中に通信エラーが発生しました。');
      await loadAll();
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    hideBanner(statusBanner);

    const fd = new FormData(form);
    const payload = {
      title: String(fd.get('title') || '').trim(),
      amount: Number(fd.get('amount') || 0),
      type: String(fd.get('type') || 'income'),
      scheduledDate: normalizeDate(String(fd.get('scheduledDate') || '')),
      note: String(fd.get('note') || '').trim(),
      accountName: '',
      customerName: String(fd.get('customerName') || '').trim(),
      staffName: String(fd.get('staffName') || '').trim(),
      labelColor: String(fd.get('labelColor') || 'blue').trim(),
      cfCategory: String(fd.get('cfCategory') || '').trim()
    };

    const err = validatePayload(payload);
    if (err) {
      showBanner(statusBanner, 'warn', err);
      return;
    }

    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/entries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        showBanner(statusBanner, 'error', '登録に失敗しました。入力値または権限を確認してください。');
        return;
      }

      showBanner(statusBanner, 'ok', '予定を追加しました。');
      form.reset();
      syncFormDateWithMonth();
      syncEntryCfCategoryOptions();
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', '登録処理中に通信エラーが発生しました。');
    } finally {
      submitBtn.disabled = false;
    }
  });

  yearInput.addEventListener('change', async () => {
    setMonthCaption();
    syncFormDateWithMonth();
    await loadAll();
  });

  entryTypeEl?.addEventListener('change', () => {
    syncEntryCfCategoryOptions();
  });


  loadSampleBtn.addEventListener('click', async () => {
    const res = await fetch('/api/sample/load', { method: 'POST' });
    if (res.ok) {
      showBanner(statusBanner, 'ok', 'サンプルデータを投入しました。');
      await loadAll();
    } else {
      showBanner(statusBanner, 'error', 'サンプルデータ投入に失敗しました。');
    }
  });

  clearSampleBtn.addEventListener('click', async () => {
    const ok = window.confirm('サンプルラベルのデータを削除しますか？');
    if (!ok) return;
    const res = await fetch('/api/sample', { method: 'DELETE' });
    if (res.ok) {
      showBanner(statusBanner, 'ok', 'サンプルデータを削除しました。');
      await loadAll();
    } else {
      showBanner(statusBanner, 'error', 'サンプルデータ削除に失敗しました。');
    }
  });
  clearAllEntriesBtn.addEventListener('click', async () => {
    const ok = window.confirm('予定一覧を全削除します。\\nこの操作は取り消せません。実行しますか？');
    if (!ok) return;
    const res = await fetch('/api/entries', { method: 'DELETE' });
    const payload = await res.json().catch(() => ({}));
    if (res.ok) {
      showBanner(statusBanner, 'ok', '予定を全削除しました。件数: ' + String(payload.affected || 0));
      await loadAll();
    } else {
      showBanner(statusBanner, 'error', payload.error || '全削除に失敗しました。');
    }
  });
  let pendingImportData = null;

  importRakurakuCsvBtn.addEventListener('click', async () => {
    const file = rakurakuCsvFileInput && rakurakuCsvFileInput.files ? rakurakuCsvFileInput.files[0] : null;
    if (!file) {
      showBanner(statusBanner, 'warn', 'CSVファイルを選択してください。');
      return;
    }
    importRakurakuCsvBtn.disabled = true;
    const previousLabel = importRakurakuCsvBtn.textContent;
    importRakurakuCsvBtn.textContent = '解析中...';
    showBanner(statusBanner, 'warn', 'CSVを解析中です。しばらくお待ちください。');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/import/rakuraku', {
        method: 'POST',
        body: formData
      });
      const rawBody = await res.text();
      const payload = safeJsonParse(rawBody) || {};
      if (!res.ok || !payload.ok) {
        showBanner(
          statusBanner,
          'error',
          buildApiErrorMessage(payload, rawBody, 'CSV解析に失敗しました。')
        );
        return;
      }
      const newEntries = payload.newEntries || [];
      const diffEntries = payload.diffEntries || [];
      if (newEntries.length === 0 && diffEntries.length === 0) {
        showBanner(statusBanner, 'ok', 'インポート対象の新しいデータ、または更新されたデータはありませんでした。');
        if (rakurakuCsvFileInput) rakurakuCsvFileInput.value = '';
        return;
      }
      pendingImportData = { newEntries, diffEntries };
      if (diffEntries.length === 0) {
        const ok = confirm(\`新規データ \${newEntries.length} 件をインポートしますか？ (重複する既存データはありません)\`);
        if (ok) {
          await commitRakurakuImport(newEntries, []);
        } else {
          pendingImportData = null;
          if (rakurakuCsvFileInput) rakurakuCsvFileInput.value = '';
        }
      } else {
        showRakurakuDiffModal(newEntries, diffEntries);
      }
    } catch (_) {
      showBanner(statusBanner, 'error', 'CSV解析中にエラーが発生しました。');
    } finally {
      importRakurakuCsvBtn.disabled = false;
      importRakurakuCsvBtn.textContent = previousLabel || '楽楽販売CSV読込';
    }
  });

  function showRakurakuDiffModal(newEntries, diffEntries) {
    if (!rakurakuDiffModal || !rakurakuDiffRows) return;
    if (rakurakuNewCount) rakurakuNewCount.textContent = String(newEntries.length);
    if (rakurakuDiffSummary) {
      rakurakuDiffSummary.textContent = \`新規追加: \${newEntries.length}件 / 差分更新: \${diffEntries.length}件\`;
    }
    rakurakuDiffRows.innerHTML = '';
    diffEntries.forEach((entry, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.idx = String(idx);
      const typeText = entry.type === 'income' ? '入金' : '出金';
      const typeClass = entry.type === 'income' ? 'income' : 'expense';
      tr.innerHTML = \`
        <td style="text-align: center;"><input type="checkbox" class="rakuraku-diff-item-check" data-idx="\${idx}" checked /></td>
        <td>\${escapeHtml(entry.managementNo || '')}</td>
        <td><span class="amount \${typeClass}">\${typeText}</span></td>
        <td>\${formatDiffCell(entry.title.old, entry.title.new)}</td>
        <td>\${formatDiffCell(formatCurrency(entry.amount.old), formatCurrency(entry.amount.new))}</td>
        <td>\${formatDiffCell(entry.scheduledDate.old, entry.scheduledDate.new)}</td>
        <td>\${formatDiffCell(entry.customerName.old, entry.customerName.new)}</td>
      \`;
      rakurakuDiffRows.appendChild(tr);
    });
    if (rakurakuDiffSelectAll) {
      rakurakuDiffSelectAll.checked = true;
    }
    rakurakuDiffModal.style.display = 'flex';
  }

  function formatDiffCell(oldVal, newVal) {
    if (oldVal === newVal) {
      return \`<span class="diff-same">\${escapeHtml(String(oldVal))}</span>\`;
    }
    return \`<span class="diff-old">\${escapeHtml(String(oldVal))}</span> &rarr; <span class="diff-new">\${escapeHtml(String(newVal))}</span>\`;
  }

  function formatCurrency(val) {
    if (val === null || val === undefined) return '';
    return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(val);
  }

  if (rakurakuDiffSelectAll) {
    rakurakuDiffSelectAll.addEventListener('change', () => {
      const checks = document.querySelectorAll('.rakuraku-diff-item-check');
      checks.forEach((chk) => {
        chk.checked = rakurakuDiffSelectAll.checked;
      });
    });
  }

  const closeRakurakuDiff = () => {
    if (rakurakuDiffModal) {
      rakurakuDiffModal.style.display = 'none';
    }
    pendingImportData = null;
    if (rakurakuCsvFileInput) {
      rakurakuCsvFileInput.value = '';
    }
  };

  document.getElementById('rakuraku-diff-close')?.addEventListener('click', closeRakurakuDiff);
  document.getElementById('rakuraku-diff-cancel')?.addEventListener('click', closeRakurakuDiff);
  rakurakuDiffModal?.addEventListener('click', (ev) => {
    if (ev.target === rakurakuDiffModal) closeRakurakuDiff();
  });

  document.getElementById('rakuraku-diff-submit')?.addEventListener('click', async () => {
    if (!pendingImportData) return;
    const submitBtn = document.getElementById('rakuraku-diff-submit');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const selectedUpdatedEntries = [];
      const checks = document.querySelectorAll('.rakuraku-diff-item-check');
      checks.forEach((chk) => {
        if (chk.checked) {
          const idx = parseInt(chk.dataset.idx, 10);
          const entry = pendingImportData.diffEntries[idx];
          if (entry) {
            selectedUpdatedEntries.push({
              id: entry.id,
              managementNo: entry.managementNo,
              type: entry.type,
              title: entry.title.new,
              amount: entry.amount.new,
              scheduledDate: entry.scheduledDate.new,
              customerName: entry.customerName.new
            });
          }
        }
      });
      await commitRakurakuImport(pendingImportData.newEntries, selectedUpdatedEntries);
      closeRakurakuDiff();
    } catch (_) {
      showBanner(statusBanner, 'error', 'コミット処理中にエラーが発生しました。');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  async function commitRakurakuImport(newEntries, updatedEntries) {
    showBanner(statusBanner, 'warn', 'データをDBに反映しています。しばらくお待ちください。');
    try {
      const res = await fetch('/api/import/rakuraku/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newEntries, updatedEntries })
      });
      const rawBody = await res.text();
      const payload = safeJsonParse(rawBody) || {};
      if (!res.ok || !payload.ok) {
        showBanner(
          statusBanner,
          'error',
          buildApiErrorMessage(payload, rawBody, 'インポートの確定に失敗しました。')
        );
        return;
      }
      showBanner(
        statusBanner,
        'ok',
        \`インポート完了: 新規追加 \${payload.insertedCount || 0} 件 / 上書き更新 \${payload.updatedCount || 0} 件\`
      );
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', 'インポートの確定中にエラーが発生しました。');
    }
  }

  csvHelpTrigger?.addEventListener('click', () => {
    if (csvHelpModal) csvHelpModal.style.display = 'flex';
  });
  const closeCsvHelp = () => {
    if (csvHelpModal) csvHelpModal.style.display = 'none';
  };
  csvHelpClose?.addEventListener('click', closeCsvHelp);
  csvHelpOk?.addEventListener('click', closeCsvHelp);
  csvHelpModal?.addEventListener('click', (ev) => {
    if (ev.target === csvHelpModal) closeCsvHelp();
  });

  importCashflowCsvBtn?.addEventListener('click', () => {
    cashflowCsvFileInput?.click();
  });
  cashflowCsvFileInput?.addEventListener('change', async () => {
    const file = cashflowCsvFileInput && cashflowCsvFileInput.files ? cashflowCsvFileInput.files[0] : null;
    if (!file) return;
    if (importCashflowCsvBtn) importCashflowCsvBtn.disabled = true;
    const previousLabel = importCashflowCsvBtn?.textContent;
    if (importCashflowCsvBtn) importCashflowCsvBtn.textContent = '取り込み中...';
    showBanner(statusBanner, 'warn', 'CSVを取り込み中です。しばらくお待ちください。');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/import/cashflow', {
        method: 'POST',
        body: formData
      });
      const rawBody = await res.text();
      const payload = safeJsonParse(rawBody) || {};
      if (!res.ok || !payload.ok) {
        showBanner(
          statusBanner,
          'error',
          buildApiErrorMessage(payload, rawBody, 'CSV取り込みに失敗しました。')
        );
        return;
      }
      if (payload.rowErrors && payload.rowErrors.length > 0) {
        statusBanner.className = 'banner show warn';
        statusBanner.innerHTML = '<strong>CSVの取り込み中に一部エラーが発生しました。以下の行はスキップされました：</strong>' +
          '<ul style="margin:4px 0 0;padding-left:20px;text-align:left;">' +
          payload.rowErrors.map(err => '<li>[' + err.rowNumber + '行目]: ' + escapeHtml(err.message) + '</li>').join('') +
          '</ul>';
      } else {
        showBanner(
          statusBanner,
          'ok',
          'CSV取込完了: 追加' + String(payload.insertedEntries || 0) + '件 / 更新' + String(payload.updatedEntries || 0) + '件'
        );
      }
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', 'CSV読み込み中にエラーが発生しました。');
    } finally {
      if (importCashflowCsvBtn) {
        importCashflowCsvBtn.disabled = false;
        importCashflowCsvBtn.textContent = previousLabel || 'CSV入力';
      }
      if (cashflowCsvFileInput) cashflowCsvFileInput.value = '';
    }
  });

  sortByDateBtn?.addEventListener('click', () => {
    reorderByDate();
  });

  listFilterKeywordEl?.addEventListener('input', () => {
    renderRows();
  });
  listFilterMonthEl?.addEventListener('change', () => {
    renderRows();
    updateSelectedMonthAlert();
  });
  listFilterTypeEl?.addEventListener('change', () => {
    renderRows();
  });
  listFilterCompletedEl?.addEventListener('change', () => {
    renderRows();
  });
  listFilterLabelEl?.addEventListener('change', () => {
    renderRows();
  });
  listFilterResetBtn?.addEventListener('click', () => {
    listFilterKeywordEl.value = '';
    listFilterMonthEl.value = 'all';
    listFilterTypeEl.value = 'all';
    listFilterCompletedEl.value = 'all';
    listFilterLabelEl.value = 'all';
    renderRows();
    updateSelectedMonthAlert();
  });
  document.querySelectorAll('[data-list-col-toggle]').forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) return;
    btn.addEventListener('click', () => {
      const key = String(btn.dataset.listColToggle || '');
      setListColumnHidden(key, !hiddenListColumns.has(key));
    });
  });
  listColumnsCollapseBtn?.addEventListener('click', () => {
    collapseDetailColumns();
  });
  listColumnsResetBtn?.addEventListener('click', () => {
    showAllListColumns();
  });
  syncListColumnToggleUi();
  applyListColumnVisibility();

  exportCsvBtn?.addEventListener('click', () => {
    const filtered = getFilteredEntries();
    if (filtered.length === 0) {
      showBanner(statusBanner, 'warn', '出力するデータがありません。');
      return;
    }
    const headers = ['ID', '予定日', '区分', 'CF区分', '件名', '金額', 'メモ', '入出金日', '顧客名', '担当社員名', '完了状態', 'ラベル', '管理番号'];
    const rows = filtered.map((e, idx) => [
      e.id || '',
      e.scheduled_date || '',
      e.type === 'income' ? '入金' : '出金',
      e.cf_category || '',
      e.title || '',
      e.amount || 0,
      e.note || '',
      e.actual_transaction_date || '',
      e.customer_name || '',
      e.staff_name || '',
      Number(e.is_completed) === 1 ? '完了' : '未完了',
      e.label_color || 'blue',
      e.import_management_no || ''
    ]);
    const csvContent = [
      headers.map(h => '"' + h.replace(/"/g, '""') + '"').join(','),
      ...rows.map(row => row.map(val => '"' + String(val).replace(/"/g, '""') + '"').join(','))
    ].join(String.fromCharCode(13, 10));
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'cashflow_' + (yearInput.value || 'data') + '.csv';
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });

  bulkSelectVisibleBtn?.addEventListener('click', () => {
    for (const e of getFilteredEntries()) selectedEntryIds.add(Number(e.id));
    renderRows();
  });
  bulkClearSelectionBtn?.addEventListener('click', () => {
    selectedEntryIds.clear();
    renderRows();
  });
  bulkEditDateBtn?.addEventListener('click', async () => {
    const normalized = await pickDateWithCalendar('', false);
    if (normalized == null) return;
    if (!normalized) {
      showBanner(statusBanner, 'warn', '日付を選択してください。');
      return;
    }
    await bulkUpdate('set_date', { scheduledDate: normalized }, '{count}件の予定日を更新しました。');
  });
  bulkEditActualDateBtn?.addEventListener('click', async () => {
    const normalized = await pickDateWithCalendar('', true);
    if (normalized == null) return;
    await bulkUpdate('set_actual_date', { actualTransactionDate: normalized }, '{count}件の確定日を更新しました。');
  });
  bulkCompleteBtn?.addEventListener('click', async () => {
    await bulkUpdate('set_completed', { isCompleted: true }, '{count}件を完了にしました。');
  });
  bulkUncompleteBtn?.addEventListener('click', async () => {
    await bulkUpdate('set_completed', { isCompleted: false }, '{count}件を未完了にしました。');
  });

  function bindToggle(btn, section, labels = { collapsed: '開く', expanded: '折りたたむ' }) {
    const syncLabel = () => {
      btn.textContent = section.classList.contains('collapsed') ? labels.collapsed : labels.expanded;
    };
    syncLabel();
    btn.addEventListener('click', () => {
      const isCollapsed = section.classList.toggle('collapsed');
      btn.textContent = isCollapsed ? labels.collapsed : labels.expanded;
    });
  }

  bindToggle(toggleAnnualBtn, annualSectionBody, { collapsed: '展開する', expanded: '折りたたむ' });
  bindToggle(toggleListBtn, listSectionBody);

  function escapeHtml(text) {
    return String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  loadAll();
</script>
</body>
</html>`;
}

function renderFiscalPage(email: string, isAdmin: boolean) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Fiscal Studio | Cashflow</title>
  <style>
    :root { --bg:#eef2f6; --ink:#1d2733; --muted:#5e7188; --card:#fff; --line:#d4dde7; --a:#0f4c81; --g:#0d8a4f; --r:#b22a34; --o:#de7a16; --p:#5a4fcf; --y:#c88a00; --accent-deep:#0b3558; --shadow:0 6px 20px rgba(10,36,64,.08);}
    *{box-sizing:border-box}
    body{margin:0;font-family:"Noto Sans JP","Hiragino Sans",sans-serif;color:var(--ink);background:linear-gradient(180deg,#f7f9fc 0%, var(--bg) 100%)}
    .wrap{max-width:1180px;margin:0 auto;padding:20px 16px 40px}
    .head{display:grid;gap:12px;grid-template-columns:1.2fr auto;align-items:end;margin-bottom:14px}
    .title{font-size:32px;font-weight:700;letter-spacing:.01em}
    .sub{color:var(--muted);font-size:13px}
    .filters{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}
    select,button{padding:9px 10px;border:1px solid #b9c8d9;border-radius:8px;background:#fff;color:var(--ink);font-size:14px}
    select:focus,button:focus{outline:2px solid rgba(15,76,129,.2);outline-offset:1px;border-color:var(--a)}
    .hero{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:10px;margin-bottom:14px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;box-shadow:0 1px 0 rgba(15,47,74,.04)}
    .hero .card{min-height:110px;display:flex;flex-direction:column;justify-content:space-between;gap:10px}
    .k{font-size:12px;color:var(--muted)}
    .v{font-weight:800;font-size:clamp(16px, 1.45vw, 22px);line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-0.04em;white-space:nowrap}
    .v.net{display:flex;flex-direction:row;align-items:baseline;gap:6px;white-space:nowrap}
    .v-sign{font-size:clamp(16px, 1.3vw, 20px);line-height:1}
    .v-amount{display:block}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .chart-title{font-weight:700;font-size:20px;margin:0 0 8px}
    svg{width:100%;height:auto;display:block}
    .legend{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}
    .dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:5px}
    .tip{position:fixed;z-index:60;pointer-events:none;background:#0f172a;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.4;box-shadow:0 8px 24px rgba(2,6,23,.25);opacity:0;transform:translateY(4px);transition:.12s ease}
    .tip.show{opacity:1;transform:translateY(0)}
    .sr{position:absolute;left:-9999px}
    @media (max-width:980px){.head{grid-template-columns:1fr}.filters{justify-content:flex-start}.grid{grid-template-columns:1fr}.hero{grid-template-columns:1fr 1fr}}
    @media (max-width:620px){.hero{grid-template-columns:1fr}.hero .card{min-height:auto}.v{font-size:20px}}
    @media print{body{background:#fff}.card{box-shadow:none}.filters,button{display:none}.wrap{max-width:none;padding:0}.title{font-size:24px}}
  </style>
</head>
<body>
<main class="wrap">
  <header class="head">
    <div>
      <div class="title">Fiscal Studio</div>
      <div class="sub">決算検討ダッシュボード | ${escapeHtml(email)}</div>
    </div>
    <div class="filters" aria-label="決算期間選択">
      <a href="/app" style="display:inline-flex;align-items:center;padding:9px 10px;border:1px solid #b9c8d9;border-radius:8px;background:#fff;color:#1d2733;text-decoration:none;font-size:14px;">Cashflow Managerへ戻る</a>
      ${isAdmin ? '<a href="/admin/backups" style="display:inline-flex;align-items:center;padding:9px 10px;border:1px solid #b9c8d9;border-radius:8px;background:#fff;color:#1d2733;text-decoration:none;font-size:14px;">バックアップ</a>' : ''}
      ${isAdmin ? '<a href="/audit" style="display:inline-flex;align-items:center;padding:9px 10px;border:1px solid #b9c8d9;border-radius:8px;background:#fff;color:#1d2733;text-decoration:none;font-size:14px;">監査ログ</a>' : ''}
      <select id="start-month" aria-label="開始月"></select>
      <select id="end-month" aria-label="終了月"></select>
      <button id="reload">更新</button>
    </div>
  </header>
  <section class="hero" aria-label="意思決定サマリーカード">
    <article class="card"><div class="k">総入金</div><div id="sum-in" class="v">0</div></article>
    <article class="card"><div class="k">総出金</div><div id="sum-out" class="v">0</div></article>
    <article class="card"><div class="k">差引</div><div id="sum-net" class="v net"><span id="sum-net-sign" class="v-sign">+</span><span id="sum-net-amount" class="v-amount">¥0</span></div></article>
    <article class="card"><div class="k">改善余地 (出金上位3比率)</div><div id="sum-top3" class="v">0%</div></article>
  </section>
  <section class="grid">
    <article class="card">
      <h2 class="chart-title">出金内訳（円グラフ）</h2>
      <svg id="pie" viewBox="0 0 420 320" role="img" aria-label="出金内訳の円グラフ"></svg>
      <div id="pie-legend" class="legend" aria-label="出金内訳凡例テキスト"></div>
    </article>
    <article class="card">
      <h2 class="chart-title">月次入出金比較（棒グラフ）</h2>
      <svg id="bar" viewBox="0 0 420 320" role="img" aria-label="月次入出金比較の棒グラフ"></svg>
      <p class="sub">青: 入金 / 赤: 出金</p>
    </article>
    <article class="card" style="grid-column:1 / -1">
      <h2 class="chart-title">差引推移（トレンド線）</h2>
      <svg id="trend" viewBox="0 0 860 280" role="img" aria-label="差引推移のトレンド線"></svg>
      <p class="sub">0ラインを下回る月は資金繰り見直し対象</p>
    </article>
  </section>
</main>
<div id="chart-tip" class="tip" role="status" aria-live="polite"></div>
<script>
const fmt = new Intl.NumberFormat('ja-JP');
const colors = ['#0f4c81','#0f8f5f','#de7a16','#5a4fcf','#b4233c','#c88a00','#0ea5a6','#6b7280'];
const startSel = document.getElementById('start-month');
const endSel = document.getElementById('end-month');
const reloadBtn = document.getElementById('reload');
const tipEl = document.getElementById('chart-tip');
const sumNetSignEl = document.getElementById('sum-net-sign');
const sumNetAmountEl = document.getElementById('sum-net-amount');
function escapeHtml(text){return String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}

function ymList(fromYear, toYear){const arr=[];for(let y=fromYear;y<=toYear;y++){for(let m=1;m<=12;m++){arr.push(String(y)+'-'+String(m).padStart(2,'0'));}}return arr;}
function init(){const now=new Date(); const ys=ymList(now.getFullYear()-2, now.getFullYear()+1); startSel.innerHTML=ys.map(v=>'<option>'+v+'</option>').join(''); endSel.innerHTML=ys.map(v=>'<option>'+v+'</option>').join(''); startSel.value=String(now.getFullYear()-1)+'-01'; endSel.value=String(now.getFullYear())+'-12';}
function polar(cx,cy,r,a){const rad=(a-90)*Math.PI/180; return {x:cx+r*Math.cos(rad), y:cy+r*Math.sin(rad)};}
function arcPath(cx,cy,r,s,e){const p1=polar(cx,cy,r,e), p2=polar(cx,cy,r,s), large=e-s<=180?0:1; return 'M '+cx+' '+cy+' L '+p2.x+' '+p2.y+' A '+r+' '+r+' 0 '+large+' 1 '+p1.x+' '+p1.y+' Z';}
function safeMax(n){return n>0?n:1;}
function line(points){return points.map((p,i)=>(i===0?'M':'L')+p[0]+' '+p[1]).join(' ');}

function renderPie(rows){
  const total = rows.reduce((s,r)=>s+Number(r.amount||0),0);
  const svg = document.getElementById('pie');
  const legend = document.getElementById('pie-legend');
  if (!rows.length || total===0){svg.innerHTML='<text x="40" y="120" fill="#607089">データがありません</text>'; legend.innerHTML=''; return;}
  let acc=0; const cx=140, cy=150, radius=96;
  const arcs = rows.map((row,i)=>{const val=Number(row.amount||0); const start=acc/total*360; acc+=val; const end=acc/total*360; const ratio=Math.round((val/total)*100); return '<path d="'+arcPath(cx,cy,radius,start,end)+'" fill="'+colors[i%colors.length]+'" data-tip="'+escapeHtml(row.title)+' | '+ratio+'% | ¥'+fmt.format(val)+'"></path>';}).join('');
  svg.innerHTML = arcs
    + '<circle cx="'+cx+'" cy="'+cy+'" r="56" fill="#fff"></circle>'
    + '<text x="'+cx+'" y="'+(cy-4)+'" text-anchor="middle" font-size="18" font-weight="800">¥'+fmt.format(total)+'</text>'
    + '<text x="'+cx+'" y="'+(cy+18)+'" text-anchor="middle" fill="#4b607d" font-size="12">総出金</text>';
  legend.innerHTML = rows.map((r,i)=>'<span><i class="dot" style="background:'+colors[i%colors.length]+'"></i>'+escapeHtml(r.title)+' '+Math.round((Number(r.amount||0)/total)*100)+'%</span>').join('');
}

function renderBar(months){
  const svg = document.getElementById('bar');
  if (!months.length){svg.innerHTML='<text x="40" y="120" fill="#607089">データがありません</text>'; return;}
  const maxv = safeMax(Math.max(...months.map(m=>Math.max(Number(m.income||0), Number(m.expense||0)))));
  const w=420,h=300,l=40,b=30,plotW=w-l-10,plotH=h-b-20,step=plotW/months.length;
  let out='<line x1="'+l+'" y1="'+(h-b)+'" x2="'+(w-10)+'" y2="'+(h-b)+'" stroke="#9fb0c6"/>';
  months.forEach((m,i)=>{const x=l+i*step+5; const iw=step*0.35, ew=step*0.35; const ih=(Number(m.income||0)/maxv)*plotH; const eh=(Number(m.expense||0)/maxv)*plotH;
    out += '<rect x="'+x+'" y="'+(h-b-ih)+'" width="'+iw+'" height="'+ih+'" fill="#0f4c81" data-tip="'+escapeHtml(m.month)+' 入金: ¥'+fmt.format(Number(m.income||0))+'"/>';
    out += '<rect x="'+(x+iw+4)+'" y="'+(h-b-eh)+'" width="'+ew+'" height="'+eh+'" fill="#b4233c" data-tip="'+escapeHtml(m.month)+' 出金: ¥'+fmt.format(Number(m.expense||0))+'"/>';
    if (i%2===0) out += '<text x="'+x+'" y="'+(h-10)+'" font-size="10" fill="#5a6b85">'+escapeHtml(m.month.slice(5))+'</text>';
  });
  svg.innerHTML = out;
}

function renderTrend(months){
  const svg = document.getElementById('trend');
  if (!months.length){svg.innerHTML='<text x="40" y="120" fill="#607089">データがありません</text>'; return;}
  const nets = months.map(m=>Number(m.income||0)-Number(m.expense||0));
  const maxAbs = safeMax(Math.max(...nets.map(n=>Math.abs(n))));
  const w=860,h=280,l=40,r=15,t=20,b=28,pw=w-l-r,ph=h-t-b,mid=t+ph/2,step=pw/Math.max(1,months.length-1);
  const points = nets.map((n,i)=>[l+i*step, mid-(n/maxAbs)*(ph/2-6)]);
  let out = '<line x1="'+l+'" y1="'+mid+'" x2="'+(w-r)+'" y2="'+mid+'" stroke="#c6d3e3" stroke-dasharray="4 4"/>';
  out += '<path d="'+line(points)+'" fill="none" stroke="#0f8f5f" stroke-width="3"/>';
  points.forEach((p,i)=>{out += '<circle cx="'+p[0]+'" cy="'+p[1]+'" r="4" fill="'+(nets[i]<0?'#b4233c':'#0f8f5f')+'" data-tip="'+escapeHtml(months[i].month)+' 差引: '+(nets[i]>=0?'+':'-')+'¥'+fmt.format(Math.abs(nets[i]))+'"/>';});
  svg.innerHTML = out;
}

function showTip(text, x, y){
  tipEl.textContent = text;
  tipEl.style.left = (x + 12) + 'px';
  tipEl.style.top = (y + 12) + 'px';
  tipEl.classList.add('show');
}

function hideTip(){
  tipEl.classList.remove('show');
}

function bindChartTooltip(id){
  const el = document.getElementById(id);
  el.addEventListener('mousemove', (ev) => {
    const target = ev.target;
    const tip = target && target.getAttribute ? target.getAttribute('data-tip') : '';
    if (!tip) { hideTip(); return; }
    showTip(tip, ev.clientX, ev.clientY);
  });
  el.addEventListener('mouseleave', hideTip);
}

function updateCards(months, breakdown){
  const income = months.reduce((s,m)=>s+Number(m.income||0),0);
  const expense = months.reduce((s,m)=>s+Number(m.expense||0),0);
  const net = income-expense;
  const top3 = breakdown.slice(0,3).reduce((s,r)=>s+Number(r.amount||0),0);
  document.getElementById('sum-in').textContent = '¥'+fmt.format(income);
  document.getElementById('sum-out').textContent = '¥'+fmt.format(expense);
  if (sumNetSignEl) sumNetSignEl.textContent = net >= 0 ? '+' : '-';
  if (sumNetAmountEl) sumNetAmountEl.textContent = '¥' + fmt.format(Math.abs(net));
  document.getElementById('sum-top3').textContent = expense>0 ? Math.round((top3/expense)*100)+'%' : '0%';
}

async function load(){
  if (startSel.value > endSel.value) {
    const t = startSel.value;
    startSel.value = endSel.value;
    endSel.value = t;
  }
  const qs = new URLSearchParams({ start:startSel.value, end:endSel.value });
  const res = await fetch('/api/fiscal-summary?'+qs.toString());
  if (!res.ok) return;
  const payload = await res.json();
  const months = Array.isArray(payload.monthlyTrend)?payload.monthlyTrend:[];
  const breakdown = Array.isArray(payload.expenseCategoryBreakdown)?payload.expenseCategoryBreakdown:[];
  updateCards(months, breakdown); renderPie(breakdown); renderBar(months); renderTrend(months);
}

reloadBtn.addEventListener('click', load);
startSel.addEventListener('change', load);
endSel.addEventListener('change', load);
init(); load();
bindChartTooltip('pie');
bindChartTooltip('bar');
bindChartTooltip('trend');
</script>
</body>
</html>`;
}

function renderCashflowStatementPage(
  email: string,
  isAdmin: boolean,
  cashflowStatementData: CashflowStatementData
) {
  const displayColumns = buildCashflowStatementDisplayColumns(2026, 2031, new Date());
  const printableMonthColumns = displayColumns.map((column, index) => ({ column, index }));
  const uncategorizedCount = cashflowStatementData.uncategorizedCount;
  const zeroDefaultRowNos = new Set([6, 7, 16, 29, 31, 42, 55, 56]);
  const sourceMonthColumnIndexes = CASHFLOW_STATEMENT_COLUMNS
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => isCashflowStatementMonthLabel(column.yearLabel));
  const monthOptionsHtml = printableMonthColumns
    .map(({ column }) => {
      const monthKey = toCashflowStatementMonthKey(column.yearLabel);
      return `<option value="${escapeHtml(monthKey)}">${escapeHtml(formatCashflowStatementMonthOption(column.yearLabel))}</option>`;
    })
    .join('');
  const defaultStartMonth = printableMonthColumns[0]?.column.yearLabel ?? '';
  const defaultEndMonth = printableMonthColumns[Math.min(11, printableMonthColumns.length - 1)]?.column.yearLabel ?? '';
  const summaryText = [
    `列数 ${displayColumns.length}`,
    `行数 ${CASHFLOW_STATEMENT_ROWS.length}`,
    '表示期間: 2026年1月〜2031年12月',
    '動的計算: CF区分ありの明細のみを集計'
  ].join(' / ');
  const uncategorizedNotice = uncategorizedCount > 0
    ? `<div class="range-alert show" style="margin-top:10px; pointer-events:none;">未分類の明細が ${uncategorizedCount} 件あります。CF区分が付くまで、資金繰り表の数値は表示しません。</div>`
    : '';
  const rowHtml = CASHFLOW_STATEMENT_ROWS.map((row, index) => {
    const gapClass = index > 0 && CASHFLOW_STATEMENT_ROWS[index - 1].rowNo + 1 < row.rowNo ? ' row-gap' : '';
    const rowClass = `row-${row.kind}${gapClass}`;
    const label = row.label ? escapeHtml(row.label) : '&nbsp;';
    const subLabel = row.subLabel ? escapeHtml(row.subLabel) : '&nbsp;';
    const sourceMonthValues = new Map<string, number | string | null>();
    sourceMonthColumnIndexes.forEach(({ column, index: columnIndex }) => {
      sourceMonthValues.set(toCashflowStatementMonthKey(column.yearLabel), row.values[columnIndex] ?? null);
    });
    const dynamicMonthValues = cashflowStatementData.valuesByRowNo.get(row.rowNo) ?? null;
    const cells = displayColumns.map((column) => {
      const monthKey = toCashflowStatementMonthKey(column.yearLabel);
      const fallbackValue = zeroDefaultRowNos.has(row.rowNo) ? 0 : null;
      const value = dynamicMonthValues?.get(monthKey) ?? sourceMonthValues.get(monthKey) ?? fallbackValue;
      const isNumber = typeof value === 'number';
      const cellClass = isNumber ? `num${value < 0 ? ' neg' : ''}` : 'empty';
      return `<td class="${cellClass}" data-col-key="${escapeHtml(column.key)}">${formatCashflowStatementValue(value)}</td>`;
    }).join('');
    return `<tr class="${rowClass}" data-row-no="${row.rowNo}">
      <th scope="row" class="sticky-col sticky-label">${label}</th>
      <td class="sticky-col sticky-sub">${subLabel}</td>
      ${cells}
    </tr>`;
  }).join('');
  const headerYearCells = displayColumns
    .map((column) => `<th class="month-col" data-col-key="${escapeHtml(column.key)}">${escapeHtml(formatCashflowStatementHeaderLabel(column.yearLabel))}</th>`)
    .join('');
  const headerStatusCells = displayColumns
    .map((column) => `<th class="month-col status-${cashflowStatementStatusClass(column.status)}" data-col-key="${escapeHtml(column.key)}">${escapeHtml(column.status)}</th>`)
    .join('');

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>資金繰り表 | Cashflow</title>
  <style>
    :root { --bg:#eef2f6; --panel:#fff; --line:#d4dde7; --text:#1d2733; --muted:#5e7188; --accent:#0f4c81; --accent-deep:#0b3558; --shadow:0 6px 20px rgba(10,36,64,.08); --total:#eef6ff; --carry:#edf9f1; --section:#f6f8fb; --heading:#fff7e8; --plan:#fff7e8; --actual:#eef7ff; --sum:#f3f6fa; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Noto Sans JP","Hiragino Sans",sans-serif; color:var(--text); background:linear-gradient(180deg,#f7f9fc 0%, var(--bg) 100%); }
    .wrap { max-width: 100%; padding: 18px 16px 36px; }
    .head { display:flex; justify-content:space-between; align-items:flex-end; gap:12px; flex-wrap:wrap; margin:0 auto 14px; max-width:1680px; }
    .title { font-size:30px; font-weight:700; }
    .sub { color:var(--muted); font-size:13px; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    .actions a { display:inline-flex; align-items:center; padding:9px 10px; border:1px solid #b9c8d9; border-radius:8px; background:#fff; color:var(--text); text-decoration:none; font-size:14px; }
    .range-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:end; margin-top:14px; position:sticky; top:12px; z-index:5; padding:8px 0 6px; background:linear-gradient(180deg, rgba(251,253,255,.98) 0%, rgba(251,253,255,.92) 100%); backdrop-filter:saturate(180%) blur(6px); }
    .range-toolbar label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
    .range-toolbar select, .range-toolbar button { border:1px solid #b9c8d9; border-radius:8px; background:#fff; color:var(--text); font-size:14px; padding:9px 10px; }
    .range-toolbar button.primary { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:700; }
    .range-note { font-size:12px; color:var(--muted); margin-top:8px; }
    .range-alert { display:none; margin-top:10px; padding:10px 12px; border-radius:10px; background:#fff4db; border:1px solid #f3d28a; color:#7a5300; font-size:13px; font-weight:700; }
    .range-alert.show { display:block; }
    .panel { max-width:1680px; margin:0 auto 14px; background:var(--panel); border:1px solid var(--line); border-radius:14px; box-shadow:0 1px 0 rgba(15,47,74,.04); overflow:hidden; }
    .panel-body { padding:16px; }
    .lead { display:grid; grid-template-columns: 1.5fr 1fr; gap:12px; align-items:start; }
    .lead-card { border:1px solid var(--line); border-radius:12px; padding:14px; background:#fbfdff; }
    .lead > .lead-card:first-child { position:sticky; top:12px; align-self:start; z-index:4; }
    .lead-card strong { display:block; margin-bottom:6px; }
    .meta { font-size:12px; color:var(--muted); }
    .table-scroll-x { overflow-x:auto; overflow-y:hidden; border-top:1px solid var(--line); border-bottom:1px solid var(--line); background:#f8fafc; height:18px; }
    .table-scroll-x.is-hidden { display:none; }
    .table-scroll-x-inner { height:1px; }
    .table-wrap { overflow:auto; border-top:1px solid var(--line); }
    table { width:max-content; min-width:100%; border-collapse:separate; border-spacing:0; font-size:12px; }
    thead th { position:sticky; top:0; z-index:3; background:#f5f8fb; color:#334e68; font-weight:700; }
    th, td { border-right:1px solid #e7edf4; border-bottom:1px solid #e7edf4; padding:8px 10px; white-space:nowrap; }
    thead tr:first-child th { border-top:0; }
    tr > *:first-child { border-left:0; }
    .sticky-col { position:sticky; left:0; z-index:2; background:#fff; }
    .sticky-sub { left:230px; min-width:130px; max-width:130px; background:#fff; }
    .sticky-label { min-width:230px; max-width:230px; }
    thead .sticky-col { z-index:4; background:#eef3f8; }
    .month-col { min-width:88px; text-align:right; }
    tbody th { text-align:left; font-weight:600; }
    td { text-align:right; font-variant-numeric:tabular-nums; }
    td.empty { color:#9aa5b1; text-align:center; }
    td.neg { color:#b22a34; }
    .row-section > * { background:var(--section); font-weight:700; }
    .row-total > * { background:var(--total); font-weight:700; }
    .row-carry > * { background:var(--carry); font-weight:700; }
    .row-heading > * { background:var(--heading); font-weight:700; }
    .row-subitem .sticky-sub { padding-left:22px; color:#44556b; }
    .row-gap > * { border-top:8px solid #fff; }
    .col-hidden { display:none; }
    .status-実績 { background:var(--actual); }
    .status-計画 { background:var(--plan); }
    .status-合計 { background:var(--sum); }
    .legend { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
    .chip { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); }
    .chip::before { content:""; width:10px; height:10px; border-radius:999px; display:inline-block; background:#cbd5e1; }
    .chip.actual::before { background:#bfdbfe; }
    .chip.plan::before { background:#fde68a; }
    .chip.total::before { background:#dbeafe; }
    .chip.carry::before { background:#bbf7d0; }
    @media (max-width: 960px) {
      .lead { grid-template-columns:1fr; }
      .sticky-label { min-width:190px; max-width:190px; }
      .sticky-sub { left:190px; min-width:110px; max-width:110px; }
      .month-col { min-width:78px; }
    }
    @page { size: A3 landscape; margin: 8mm; }
    @media print {
      body { background:#fff; }
      .wrap { padding:0; }
      .head, .range-toolbar, .range-note, .range-alert, .table-scroll-x { display:none !important; }
      .panel { max-width:none; margin:0; border:0; box-shadow:none; border-radius:0; }
      .panel-body { display:none; }
      table { width:100% !important; min-width:0; font-size:9px; }
      th, td { padding:4px 6px; }
      .sticky-col, .sticky-sub, .sticky-label, thead .sticky-col { position:static; left:auto; }
      .table-wrap { overflow:visible; border-top:1px solid var(--line); }
      .month-col { min-width:0; }
    }
  </style>
</head>
<body>
<main class="wrap">
  <header class="head">
    <div>
      <div class="title">資金繰り表</div>
      <div class="sub">Excel原本をWebで再現したたたき台 | ${escapeHtml(email)}</div>
    </div>
    <div class="actions">
      <a href="/app">Cashflow Managerへ戻る</a>
      <a href="/fiscal">年間サマリー</a>
      ${isAdmin ? '<a href="/audit">監査ログ</a>' : ''}
    </div>
  </header>

  <section class="panel">
    <div class="panel-body">
      <div class="lead">
        <div class="lead-card">
          <strong>このページの役割</strong>
          <div class="sub">2026年から2031年までの月列を先に用意し、月が終了したら自動で「計画」から「実績」へ切り替わる前提の表示にしています。現在は、前月繰越 / 経常収入 / 経常支出 / 経常収支 / 財務等収入 / 財務等支出 / 財務等収支 / 次月繰越金を明細のCF区分から自動集計しています。</div>
          <div class="range-toolbar">
            <label>
              開始月
              <select id="pdf-range-start">${monthOptionsHtml}</select>
            </label>
            <label>
              終了月
              <select id="pdf-range-end">${monthOptionsHtml}</select>
            </label>
            <button id="apply-range" type="button">表示に反映</button>
            <button id="print-pdf" type="button" class="primary">PDF保存</button>
            <button id="export-excel" type="button">Excel出力</button>
          </div>
          <div class="range-note">A3・1枚想定のため、PDF保存できる月範囲は最大12か月までに制限しています。</div>
          ${uncategorizedNotice}
          <div id="range-alert" class="range-alert" role="alert"></div>
        </div>
        <div class="lead-card">
        <strong>表示内容</strong>
        <div class="meta">${escapeHtml(summaryText)}</div>
          <div class="legend">
            <span class="chip actual">実績</span>
            <span class="chip plan">計画</span>
            <span class="chip total">収支・合計</span>
            <span class="chip carry">繰越</span>
          </div>
        </div>
      </div>
    </div>
    <div id="table-scroll-x" class="table-scroll-x" aria-hidden="true">
      <div id="table-scroll-x-inner" class="table-scroll-x-inner"></div>
    </div>
    <div id="table-wrap" class="table-wrap">
      <table id="cashflow-statement-table" aria-label="資金繰り表">
        <thead>
          <tr>
            <th class="sticky-col sticky-label">項目</th>
            <th class="sticky-col sticky-sub">補足</th>
            ${headerYearCells}
          </tr>
          <tr>
            <th class="sticky-col sticky-label">区分</th>
            <th class="sticky-col sticky-sub">内訳</th>
            ${headerStatusCells}
          </tr>
        </thead>
        <tbody>
          ${rowHtml}
        </tbody>
      </table>
    </div>
  </section>
</main>
<script>
  const MAX_PDF_MONTH_RANGE = 12;
  const printableMonthKeys = ${JSON.stringify(printableMonthColumns.map(({ column }) => toCashflowStatementMonthKey(column.yearLabel)))};
  const monthColumnMap = ${JSON.stringify(printableMonthColumns.map(({ column, index }) => ({ key: toCashflowStatementMonthKey(column.yearLabel), columnKey: column.key, index })))};
  const topScrollEl = document.getElementById('table-scroll-x');
  const topScrollInnerEl = document.getElementById('table-scroll-x-inner');
  const tableWrapEl = document.getElementById('table-wrap');
  const statementTableEl = document.getElementById('cashflow-statement-table');
  const rangeStartEl = document.getElementById('pdf-range-start');
  const rangeEndEl = document.getElementById('pdf-range-end');
  const applyRangeBtn = document.getElementById('apply-range');
  const printPdfBtn = document.getElementById('print-pdf');
  const exportExcelBtn = document.getElementById('export-excel');
  const rangeAlertEl = document.getElementById('range-alert');
  let syncingScroll = false;

  function showRangeAlert(message) {
    if (!rangeAlertEl) return;
    rangeAlertEl.textContent = message;
    rangeAlertEl.classList.add('show');
  }

  function hideRangeAlert() {
    if (!rangeAlertEl) return;
    rangeAlertEl.textContent = '';
    rangeAlertEl.classList.remove('show');
  }

  function getSelectedMonthRange() {
    const startKey = String(rangeStartEl?.value || '');
    const endKey = String(rangeEndEl?.value || '');
    const startIndex = printableMonthKeys.indexOf(startKey);
    const endIndex = printableMonthKeys.indexOf(endKey);
    if (startIndex === -1 || endIndex === -1) {
      return { ok: false, message: '開始月または終了月が不正です。' };
    }
    if (startIndex > endIndex) {
      return { ok: false, message: '開始月は終了月以前を選択してください。' };
    }
    return { ok: true, startIndex, endIndex, monthCount: endIndex - startIndex + 1 };
  }

  function applySelectedRange() {
    const result = getSelectedMonthRange();
    if (!result.ok) {
      showRangeAlert(result.message);
      return false;
    }
    hideRangeAlert();
    const visibleColumnKeys = new Set(monthColumnMap
      .slice(result.startIndex, result.endIndex + 1)
      .map((item) => item.columnKey));
    const cells = statementTableEl?.querySelectorAll('[data-col-key]') || [];
    cells.forEach((cell) => {
      const key = cell.getAttribute('data-col-key') || '';
      cell.classList.toggle('col-hidden', !visibleColumnKeys.has(key));
    });
    syncStatementScrollMetrics();
    if (tableWrapEl) tableWrapEl.scrollLeft = 0;
    if (topScrollEl) topScrollEl.scrollLeft = 0;
    return true;
  }

  function handlePrintPdf() {
    const result = getSelectedMonthRange();
    if (!result.ok) {
      showRangeAlert(result.message);
      return;
    }
    if (result.monthCount > MAX_PDF_MONTH_RANGE) {
      showRangeAlert('選択範囲が長すぎます。A3・1枚で保存するため、PDF保存は12か月以内で選択してください。');
      return;
    }
    if (!applySelectedRange()) return;
    showRangeAlert('印刷ダイアログを開いています。');
    window.setTimeout(() => window.print(), 0);
  }

  function buildExportFileName(extension) {
    const startKey = String(rangeStartEl?.value || '');
    const endKey = String(rangeEndEl?.value || '');
    return 'cashflow_statement_' + startKey + '_to_' + endKey + '.' + extension;
  }

  function escapeExcelHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function escapeExcelXml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  }

  const XLSX_MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const XLSX_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

  function toExcelColumnLabel(index) {
    let n = index;
    let label = '';
    while (n > 0) {
      const remainder = (n - 1) % 26;
      label = String.fromCharCode(65 + remainder) + label;
      n = Math.floor((n - 1) / 26);
    }
    return label;
  }

  function encodeUtf8(text) {
    return new TextEncoder().encode(String(text));
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let j = 0; j < 8; j += 1) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function u16(value) {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, true);
    return out;
  }

  function u32(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, true);
    return out;
  }

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function buildZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBytes = encodeUtf8(entry.name);
      const dataBytes = entry.data instanceof Uint8Array ? entry.data : encodeUtf8(entry.data);
      const crc = crc32(dataBytes);
      const localHeader = concatBytes([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(dataBytes.length), u32(dataBytes.length), u16(nameBytes.length), u16(0)]);
      localParts.push(localHeader, nameBytes, dataBytes);
      const centralHeader = concatBytes([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(dataBytes.length), u32(dataBytes.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)]);
      centralParts.push(centralHeader, nameBytes);
      offset += localHeader.length + nameBytes.length + dataBytes.length;
    }
    const centralDirectory = concatBytes(centralParts);
    const localData = concatBytes(localParts);
    const eocd = concatBytes([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralDirectory.length), u32(localData.length), u16(0)]);
    return concatBytes([localData, centralDirectory, eocd]);
  }

  function xmlInlineString(value) {
    return '<c t="inlineStr"><is><t xml:space="preserve">' + escapeExcelXml(value) + '</t></is></c>';
  }

  function xmlNumberCell(value, style = 1) {
    return '<c s="' + style + '" t="n"><v>' + String(Number(value || 0)) + '</v></c>';
  }

  function xmlFormulaCell(formula, value) {
    return '<c s="1"><f>' + escapeExcelXml(formula) + '</f><v>' + String(Number(value || 0)) + '</v></c>';
  }

  function buildWorkbookXml() {
    const exportRows = Array.from(statementTableEl?.querySelectorAll('thead tr, tbody tr') || []);
    const rowNoToWorkbookRow = new Map();
    exportRows.forEach((row, index) => {
      const rowNo = Number((row instanceof HTMLElement ? row.dataset.rowNo : '') || '0');
      if (Number.isInteger(rowNo) && rowNo > 0) {
        rowNoToWorkbookRow.set(rowNo, index + 1);
      }
    });

    const sheetRows = exportRows.map((row, rowIndex) => {
      const sheetRowNo = rowIndex + 1;
      const rowNo = Number((row instanceof HTMLElement ? row.dataset.rowNo : '') || '0');
      const cells = Array.from(row.children).filter((cell) => cell instanceof HTMLElement && !cell.classList.contains('col-hidden'));
      const rowCells = cells.map((cell, cellIndex) => {
        const isHeaderCell = cell.tagName.toLowerCase() === 'th';
        const text = cell.textContent || '';
        const monthCellIndex = cellIndex - 2;
        const monthColumnNumber = cellIndex + 1;
        if (rowNo > 0 && monthCellIndex >= 0) {
          const cellText = text.trim();
          const numericValue = cellText === '' || cellText === '–' ? 0 : Number(cellText.replaceAll(',', ''));
          const row6 = rowNoToWorkbookRow.get(6);
          const row7 = rowNoToWorkbookRow.get(7);
          const row8 = rowNoToWorkbookRow.get(8);
          const row15 = rowNoToWorkbookRow.get(15);
          const row16 = rowNoToWorkbookRow.get(16);
          const row17 = rowNoToWorkbookRow.get(17);
          const row28 = rowNoToWorkbookRow.get(28);
          const row29 = rowNoToWorkbookRow.get(29);
          const row31 = rowNoToWorkbookRow.get(31);
          const row32 = rowNoToWorkbookRow.get(32);
          const row41 = rowNoToWorkbookRow.get(41);
          const row42 = rowNoToWorkbookRow.get(42);
          const row43 = rowNoToWorkbookRow.get(43);
          const row54 = rowNoToWorkbookRow.get(54);
          const row55 = rowNoToWorkbookRow.get(55);
          const row56 = rowNoToWorkbookRow.get(56);
          if (rowNo === 6) {
            if (monthCellIndex === 0 || !row56) return xmlNumberCell(0);
            return xmlFormulaCell(toExcelColumnLabel(monthColumnNumber - 1) + row56, numericValue);
          }
          if (rowNo === 7 && row8 && row15) return xmlFormulaCell('SUM(' + toExcelColumnLabel(monthColumnNumber) + row8 + ':' + toExcelColumnLabel(monthColumnNumber) + row15 + ')', numericValue);
          if (rowNo === 16 && row17 && row28) return xmlFormulaCell('SUM(' + toExcelColumnLabel(monthColumnNumber) + row17 + ':' + toExcelColumnLabel(monthColumnNumber) + row28 + ')', numericValue);
          if (rowNo === 29 && row7 && row16) return xmlFormulaCell(toExcelColumnLabel(monthColumnNumber) + row7 + '-' + toExcelColumnLabel(monthColumnNumber) + row16, numericValue);
          if (rowNo === 31 && row32 && row41) return xmlFormulaCell('SUM(' + toExcelColumnLabel(monthColumnNumber) + row32 + ':' + toExcelColumnLabel(monthColumnNumber) + row41 + ')', numericValue);
          if (rowNo === 42 && row43 && row54) return xmlFormulaCell('SUM(' + toExcelColumnLabel(monthColumnNumber) + row43 + ':' + toExcelColumnLabel(monthColumnNumber) + row54 + ')', numericValue);
          if (rowNo === 55 && row31 && row42) return xmlFormulaCell(toExcelColumnLabel(monthColumnNumber) + row31 + '-' + toExcelColumnLabel(monthColumnNumber) + row42, numericValue);
          if (rowNo === 56 && row6 && row29 && row55) return xmlFormulaCell(toExcelColumnLabel(monthColumnNumber) + row6 + '+' + toExcelColumnLabel(monthColumnNumber) + row29 + '+' + toExcelColumnLabel(monthColumnNumber) + row55, numericValue);
          if (cellText === '' || cellText === '–') return '<c/>';
          return xmlNumberCell(Number.isFinite(numericValue) ? numericValue : 0);
        }
        if (isHeaderCell) return xmlInlineString(text.trim());
        const value = text.trim();
        if (value === '') return '<c/>';
        const parsed = Number(value.replaceAll(',', ''));
        if (!Number.isNaN(parsed) && /^[\d,.-]+$/.test(value)) return xmlNumberCell(parsed);
        return xmlInlineString(value);
      }).join('');
      return '<row r="' + sheetRowNo + '">' + rowCells + '</row>';
    }).join('');

    const usedColumnCount = Math.max(
      1,
      ...exportRows.map((row) => Array.from(row.children).filter((cell) => cell instanceof HTMLElement && !cell.classList.contains('col-hidden')).length)
    );
    const usedRange = 'A1:' + toExcelColumnLabel(usedColumnCount) + sheetRows.length;
    const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="' + XLSX_MAIN_NS + '" xmlns:r="' + XLSX_REL_NS + '">' +
      '<dimension ref="' + usedRange + '"/>' +
      '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
      '<sheetData>' + sheetRows + '</sheetData>' +
      '<autoFilter ref="' + usedRange + '"/>' +
      '</worksheet>';
    const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="' + XLSX_MAIN_NS + '" xmlns:r="' + XLSX_REL_NS + '">' +
      '<fileVersion appName="xl"/>' +
      '<workbookPr calcMode="auto"/>' +
      '<bookViews><workbookView activeTab="0"/></bookViews>' +
      '<sheets><sheet name="資金繰り表" sheetId="1" r:id="rId1"/></sheets>' +
      '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>' +
      '</workbook>';
    const workbookRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="' + PKG_REL_NS + '">' +
      '<Relationship Id="rId1" Type="' + XLSX_REL_NS + '/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>';
    const rootRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="' + PKG_REL_NS + '">' +
      '<Relationship Id="rId1" Type="' + XLSX_REL_NS + '/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';
    const contentTypesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>';
    const nowIso = new Date().toISOString();
    const coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>資金繰り表</dc:title>' +
      '<dc:creator>Cashflow Manager</dc:creator>' +
      '<cp:lastModifiedBy>Cashflow Manager</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + nowIso + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + nowIso + '</dcterms:modified>' +
      '</cp:coreProperties>';
    const appXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>Cashflow Manager</Application>' +
      '</Properties>';
    const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="' + XLSX_MAIN_NS + '">' +
      '<fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><sz val="11"/><name val="Yu Gothic"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left"/></xf>' +
      '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
      '</cellXfs>' +
      '</styleSheet>';
    return buildZip([
      { name: '[Content_Types].xml', data: contentTypesXml },
      { name: '_rels/.rels', data: rootRelsXml },
      { name: 'docProps/app.xml', data: appXml },
      { name: 'docProps/core.xml', data: coreXml },
      { name: 'xl/workbook.xml', data: workbookXml },
      { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
      { name: 'xl/styles.xml', data: stylesXml },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml }
    ]);
  }

  function handleExportExcel() {
    if (!applySelectedRange()) return;
    showRangeAlert('Excelファイルをダウンロードしています。');
    try {
      const workbookZip = buildWorkbookXml();
      const blob = new Blob([workbookZip], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = buildExportFileName('xlsx');
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error('Excel export failed', error);
      showRangeAlert('Excel出力に失敗しました。画面を再読み込みして再試行してください。');
    }
  }

  function syncStatementScrollMetrics() {
    if (!topScrollEl || !topScrollInnerEl || !tableWrapEl || !statementTableEl) return;
    const fullWidth = statementTableEl.scrollWidth;
    const visibleWidth = tableWrapEl.clientWidth;
    topScrollInnerEl.style.width = fullWidth + 'px';
    topScrollEl.classList.toggle('is-hidden', fullWidth <= visibleWidth + 1);
  }

  function syncTopScrollFromTable() {
    if (!topScrollEl || !tableWrapEl || syncingScroll) return;
    syncingScroll = true;
    topScrollEl.scrollLeft = tableWrapEl.scrollLeft;
    syncingScroll = false;
  }

  function syncTableScrollFromTop() {
    if (!topScrollEl || !tableWrapEl || syncingScroll) return;
    syncingScroll = true;
    tableWrapEl.scrollLeft = topScrollEl.scrollLeft;
    syncingScroll = false;
  }

  if (rangeStartEl) rangeStartEl.value = ${JSON.stringify(toCashflowStatementMonthKey(defaultStartMonth))};
  if (rangeEndEl) rangeEndEl.value = ${JSON.stringify(toCashflowStatementMonthKey(defaultEndMonth))};
  applySelectedRange();
  syncStatementScrollMetrics();
  topScrollEl?.addEventListener('scroll', syncTableScrollFromTop, { passive: true });
  tableWrapEl?.addEventListener('scroll', syncTopScrollFromTable, { passive: true });
  applyRangeBtn?.addEventListener('click', applySelectedRange);
  printPdfBtn?.addEventListener('click', handlePrintPdf);
  exportExcelBtn?.addEventListener('click', handleExportExcel);
  window.addEventListener('resize', syncStatementScrollMetrics);
</script>
</body>
</html>`;
}

function renderAuditPage(email: string) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>監査ログ | Cashflow</title>
  <style>
    :root { --bg:#eef2f6; --panel:#fff; --line:#d4dde7; --text:#1d2733; --muted:#5e7188; --accent:#0f4c81; --ok:#0d8a4f; --warn:#b22a34; }
    *{box-sizing:border-box}
    body{margin:0;font-family:"Noto Sans JP","Hiragino Sans",sans-serif;background:linear-gradient(180deg,#f7f9fc 0%, var(--bg) 100%);color:var(--text)}
    .wrap{max-width:1180px;margin:0 auto;padding:18px 16px 36px}
    .head{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:14px}
    .title{font-size:30px;font-weight:700}
    .sub{font-size:13px;color:var(--muted)}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .actions a,.actions button,.actions select,.actions input{padding:9px 10px;border:1px solid #b9c8d9;border-radius:8px;background:#fff;color:var(--text);font-size:14px;text-decoration:none}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
    .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .toolbar label{font-size:12px;color:var(--muted)}
    .table-wrap{overflow:auto;border:1px solid #e1e8f0;border-radius:10px;margin-top:10px}
    table{width:100%;border-collapse:collapse;font-size:13px;min-width:860px}
    th,td{border-bottom:1px solid #e7edf4;text-align:left;padding:9px 8px;vertical-align:top}
    th{background:#f5f8fb;font-weight:700;color:#334e68}
    .tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
    .tag.add{background:#edf9f1;color:var(--ok)}
    .tag.edit{background:#eef4ff;color:#265d9c}
    .tag.delete{background:#fef0f1;color:var(--warn)}
    .muted{color:var(--muted)}
  </style>
</head>
<body>
<main class="wrap">
  <header class="head">
    <div>
      <div class="title">監査ログ</div>
      <div class="sub">ログイン履歴と操作履歴を確認 | ${escapeHtml(email)}</div>
    </div>
    <div class="actions">
      <a href="/app">Cashflow Managerへ戻る</a>
      <a href="/fiscal">Fiscal Studio</a>
      <a href="/admin/backups">バックアップ</a>
    </div>
  </header>

  <section class="panel">
    <div class="toolbar">
      <label>開始日 <input id="from" type="date" /></label>
      <label>終了日 <input id="to" type="date" /></label>
      <label>操作種別
        <select id="action">
          <option value="">すべて</option>
          <option value="add">追加</option>
          <option value="edit">編集</option>
          <option value="delete">削除</option>
        </select>
      </label>
      <label>ユーザー <input id="email" type="email" placeholder="例: user@energio.jp" /></label>
      <button id="reload">更新</button>
    </div>
  </section>

  <section class="panel">
    <h2 style="margin:0 0 8px;font-size:20px;">ログイン/ログアウト履歴</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ユーザー</th><th>ログイン時刻</th><th>ログアウト時刻</th><th>理由</th><th>セッション</th></tr></thead>
        <tbody id="session-rows"></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <h2 style="margin:0 0 8px;font-size:20px;">操作履歴（追加・編集・削除）</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ユーザー</th><th>時刻</th><th>操作</th><th>対象</th><th>対象ID</th><th>詳細</th></tr></thead>
        <tbody id="op-rows"></tbody>
      </table>
    </div>
  </section>
</main>
<script>
  const fromEl = document.getElementById('from');
  const toEl = document.getElementById('to');
  const actionEl = document.getElementById('action');
  const emailEl = document.getElementById('email');
  const reloadBtn = document.getElementById('reload');
  const sessionRows = document.getElementById('session-rows');
  const opRows = document.getElementById('op-rows');
  const auditDateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  function esc(s){return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');}
  function formatDateInputValue(date){
    const parts = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return map.year + '-' + map.month + '-' + map.day;
  }
  function formatAuditDateTime(value){
    const raw = String(value || '').trim();
    if (!raw) return '-';
    const match = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
    const iso = match ? match[1] + 'T' + match[2] + 'Z' : raw;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return raw;
    return auditDateTimeFormatter.format(parsed);
  }

  function initDates(){
    const now = new Date();
    const to = formatDateInputValue(now);
    const fromDate = new Date(now.getTime() - 29*24*60*60*1000);
    const from = formatDateInputValue(fromDate);
    fromEl.value = from;
    toEl.value = to;
  }

  async function loadAudit(){
    const from = fromEl.value;
    const to = toEl.value;
    const action = actionEl.value;
    const email = String(emailEl.value || '').trim().toLowerCase();
    const q1 = new URLSearchParams({ from, to, email });
    const q2 = new URLSearchParams({ from, to, action, email });
    const [sRes, oRes] = await Promise.all([
      fetch('/api/audit/session-logs?' + q1.toString()),
      fetch('/api/audit/operation-logs?' + q2.toString())
    ]);
    if (!sRes.ok || !oRes.ok) return;
    const s = await sRes.json();
    const o = await oRes.json();
    const sLogs = Array.isArray(s.logs) ? s.logs : [];
    const oLogs = Array.isArray(o.logs) ? o.logs : [];

    sessionRows.innerHTML = sLogs.length ? sLogs.map((r) =>
      '<tr><td>' + esc(r.user_email || '-') + '</td><td>' + esc(formatAuditDateTime(r.login_at)) + '</td><td>' + esc(formatAuditDateTime(r.logout_at)) + '</td><td>' + esc(r.logout_reason || '-') + '</td><td class=\"muted\">' + esc(r.session_token_masked || '-') + '</td></tr>'
    ).join('') : '<tr><td colspan=\"5\" class=\"muted\">履歴がありません</td></tr>';

    opRows.innerHTML = oLogs.length ? oLogs.map((r) =>
      '<tr><td>' + esc(r.user_email || '-') + '</td><td>' + esc(formatAuditDateTime(r.created_at)) + '</td><td><span class=\"tag ' + esc(r.action_type) + '\">' + esc(r.action_type) + '</span></td><td>' + esc(r.target_type) + '</td><td>' + esc(r.target_id ?? '-') + '</td><td class=\"muted\">' + esc(r.detail || '-') + '</td></tr>'
    ).join('') : '<tr><td colspan=\"6\" class=\"muted\">履歴がありません</td></tr>';
  }

  reloadBtn.addEventListener('click', loadAudit);
  fromEl.addEventListener('change', loadAudit);
  toEl.addEventListener('change', loadAudit);
  actionEl.addEventListener('change', loadAudit);
  emailEl.addEventListener('change', loadAudit);
  initDates();
  loadAudit();
</script>
</body>
</html>`;
}

function renderBackupsPage(email: string, backups: CashflowEntryBackupListRow[], status?: string) {
  const statusText = status === 'created'
    ? 'バックアップを作成しました。'
    : status === 'restored'
      ? 'バックアップを復元しました。'
      : status === 'empty'
        ? 'バックアップ対象の明細がありませんでした。'
        : '';
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>バックアップ管理 | Cashflow</title>
  <style>
    :root { --bg:#eef2f6; --panel:#fff; --line:#d4dde7; --text:#1d2733; --muted:#5e7188; --accent:#0f4c81; --accent-deep:#0b3558; --ok-bg:#edf9f1; --ok-line:#bce7cb; --warn-bg:#fff4db; --warn-line:#f3d28a; --shadow:0 6px 20px rgba(10,36,64,.08); }
    *{box-sizing:border-box}
    body{margin:0;font-family:"Noto Sans JP","Hiragino Sans",sans-serif;background:linear-gradient(180deg,#f7f9fc 0%, var(--bg) 100%);color:var(--text)}
    .wrap{max-width:1180px;margin:0 auto;padding:18px 16px 36px}
    .head{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:14px}
    .title{font-size:30px;font-weight:700}
    .sub{font-size:13px;color:var(--muted)}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .actions a,.actions button,.actions input,.actions select{padding:9px 10px;border:1px solid #b9c8d9;border-radius:8px;background:#fff;color:var(--text);font-size:14px;text-decoration:none}
    .actions button{cursor:pointer}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 1px 0 rgba(15,47,74,.04)}
    .toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .banner{border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:13px}
    .banner.ok{background:var(--ok-bg);border:1px solid var(--ok-line);color:#155e36}
    .banner.warn{background:var(--warn-bg);border:1px solid var(--warn-line);color:#7a5300}
    .muted{color:var(--muted)}
    .table-wrap{overflow:auto;border:1px solid #e1e8f0;border-radius:10px;margin-top:10px}
    table{width:100%;border-collapse:collapse;font-size:13px;min-width:860px}
    th,td{border-bottom:1px solid #e7edf4;text-align:left;padding:9px 8px;vertical-align:top}
    th{background:#f5f8fb;font-weight:700;color:#334e68}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
    .pill.manual{background:#eef4ff;color:#265d9c}
    .pill.scheduled{background:#edf9f1;color:#155e36}
    .restore-form{display:inline-flex}
    .restore-form button{border:1px solid #b9c8d9;border-radius:8px;background:#fff;padding:8px 10px;font-size:13px;cursor:pointer}
    .empty{padding:18px;color:var(--muted);text-align:center}
  </style>
</head>
<body>
<main class="wrap">
  <header class="head">
    <div>
      <div class="title">バックアップ管理</div>
      <div class="sub">明細だけを毎日23:59(JST)に自動保存し、${CASHFLOW_BACKUP_RETENTION_DAYS}日で自動削除します | ${escapeHtml(email)}</div>
    </div>
    <div class="actions">
      <a href="/app">Cashflow Managerへ戻る</a>
      <a href="/fiscal">Fiscal Studio</a>
      <a href="/audit">監査ログ</a>
    </div>
  </header>

  <section class="panel">
    ${statusText ? `<div class="banner ${status === 'empty' ? 'warn' : 'ok'}">${escapeHtml(statusText)}</div>` : ''}
    <div class="toolbar">
      <form method="post" action="/admin/backups/run">
        <button type="submit">今すぐバックアップ</button>
      </form>
      <span class="muted">復元は現在の明細を上書きします。必要なときだけ実行してください。</span>
    </div>
  </section>

  <section class="panel">
    <div class="toolbar">
      <strong>保存済みバックアップ</strong>
      <span class="muted">最新順で表示</span>
    </div>
    <div class="table-wrap">
      ${backups.length > 0 ? `
      <table>
        <thead><tr><th>作成日時</th><th>件数</th><th>種別</th><th>作成者</th><th>復元日時</th><th>操作</th></tr></thead>
        <tbody>
          ${backups.map((backup) => `
            <tr>
              <td>${escapeHtml(formatJstDateTime(backup.created_at))}</td>
              <td>${escapeHtml(formatNumber(backup.entry_count))}</td>
              <td><span class="pill ${escapeHtml(backup.source)}">${backup.source === 'scheduled' ? '自動' : '手動'}</span></td>
              <td>${escapeHtml(backup.created_by_email || '-')}</td>
              <td>${escapeHtml(formatJstDateTime(backup.restored_at))}</td>
              <td>
                <form class="restore-form" method="post" action="/admin/backups/${backup.id}/restore" onsubmit="return confirm('このバックアップで現在の明細を上書き復元します。よろしいですか？');">
                  <button type="submit">このバックアップで復元</button>
                </form>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ` : `<div class="empty">まだバックアップはありません。</div>`}
    </div>
  </section>
</main>
</body>
</html>`;
}

function renderPasswordChangePage(email: string, message?: string, success = false) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>パスワード変更 | Cashflow</title>
  <style>
    body { font-family: "Noto Sans JP", "Hiragino Sans", sans-serif; margin: 0; background: #f4f6f8; color: #1f2933; }
    .box { max-width: 460px; margin: 8vh auto; background: #fff; border: 1px solid #d9e2ec; border-radius: 10px; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 22px; }
    .user { margin: 0 0 14px; color: #486581; font-size: 13px; }
    .hint { margin: 0 0 12px; padding: 10px; border-radius: 8px; background: #eef4ff; border: 1px solid #c7d7fe; color: #1e3a8a; font-size: 13px; line-height: 1.5; }
    label { display: block; margin: 10px 0 6px; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #bcccdc; border-radius: 8px; padding: 10px; }
    .msg { padding: 10px; border-radius: 8px; margin-bottom: 12px; }
    .msg.error { background: #ffe3e3; color: #7f1d1d; border: 1px solid #fecaca; }
    .msg.ok { background: #edf9f1; color: #155e36; border: 1px solid #bce7cb; }
    .actions { margin-top: 14px; display: flex; gap: 8px; }
    button, a { border: 0; background: #0f4c81; color: #fff; padding: 11px 12px; border-radius: 8px; font-weight: 700; cursor: pointer; text-decoration: none; font-size: 14px; }
    a { background: #486581; }
  </style>
</head>
<body>
  <main class="box">
    <h1>パスワード変更</h1>
    <p class="user">${escapeHtml(email)}</p>
    <div class="hint">
      パスワード要件: 10〜128文字、英小文字・英大文字・数字・記号をそれぞれ1文字以上含めてください。
    </div>
    ${message ? `<div class="msg ${success ? 'ok' : 'error'}">${escapeHtml(message)}</div>` : ''}
    <form method="post" action="/password-change">
      <label>現在のパスワード</label>
      <input type="password" name="currentPassword" required />
      <label>新しいパスワード</label>
      <input type="password" name="newPassword" minlength="10" required />
      <label>新しいパスワード（確認）</label>
      <input type="password" name="newPasswordConfirm" minlength="10" required />
      <div class="actions">
        <button type="submit">更新する</button>
        <a href="/app">戻る</a>
      </div>
    </form>
  </main>
</body>
</html>`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('ja-JP').format(Number(value || 0));
}

function formatJstDateTime(value?: string | null): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '-';
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  const parsed = new Date(match ? `${match[1]}T${match[2]}Z` : raw);
  if (Number.isNaN(parsed.getTime())) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(parsed);
}

type CashflowEntryBackupSnapshotRow = {
  id: number;
  user_id: number;
  organization_id: number | null;
  title: string;
  amount: number;
  type: 'income' | 'expense';
  scheduled_date: string;
  order_index: number;
  note: string | null;
  account_name: string | null;
  actual_transaction_date: string | null;
  customer_name: string | null;
  staff_name: string | null;
  label_color: string;
  cf_category: string;
  import_source_file_name: string | null;
  import_management_no: string | null;
  import_batch_id: string | null;
  is_sample: number;
  is_completed: number;
  created_by_user_id: number | null;
};

async function pruneCashflowEntryBackups(db: D1Database): Promise<void> {
  await db.prepare(
    `DELETE FROM cashflow_entry_backups
     WHERE created_at < datetime('now', '-${CASHFLOW_BACKUP_RETENTION_DAYS} days')`
  ).run();
}

async function listCashflowEntryBackups(db: D1Database, organizationId: number): Promise<CashflowEntryBackupListRow[]> {
  const rows = await db.prepare(
    `SELECT
      b.id,
      b.organization_id,
      b.source,
      b.entry_count,
      b.created_at,
      b.restored_at,
      cu.email AS created_by_email,
      ru.email AS restored_by_email
     FROM cashflow_entry_backups b
     LEFT JOIN users cu ON cu.id = b.created_by_user_id
     LEFT JOIN users ru ON ru.id = b.restored_by_user_id
     WHERE b.organization_id = ?
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT 100`
  )
    .bind(organizationId)
    .all<CashflowEntryBackupListRow>();

  return rows.results ?? [];
}

async function createCashflowEntryBackup(
  db: D1Database,
  organizationId: number,
  createdByUserId: number | null,
  source: CashflowEntryBackupSource
): Promise<CashflowEntryBackupListRow | null> {
  const rows = await db.prepare(
    `SELECT
      id,
      user_id,
      organization_id,
      title,
      amount,
      type,
      scheduled_date,
      order_index,
      note,
      account_name,
      actual_transaction_date,
      customer_name,
      staff_name,
      label_color,
      cf_category,
      import_source_file_name,
      import_management_no,
      import_batch_id,
      is_sample,
      is_completed,
      created_by_user_id
     FROM cashflow_entries
     WHERE organization_id = ? AND deleted_at IS NULL
     ORDER BY scheduled_date ASC, order_index ASC, id ASC`
  )
    .bind(organizationId)
    .all<CashflowEntryBackupSnapshotRow>();

  const snapshotRows = rows.results ?? [];
  if (snapshotRows.length === 0) {
    return null;
  }

  const snapshotJson = JSON.stringify(snapshotRows);
  const insertResult = await db.prepare(
    `INSERT INTO cashflow_entry_backups
      (organization_id, source, snapshot_json, entry_count, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(organizationId, source, snapshotJson, snapshotRows.length, createdByUserId).run();

  const backupId = Number(insertResult.meta?.last_row_id ?? 0);
  const insertedRow = await db.prepare(
    `SELECT
      b.id,
      b.organization_id,
      b.source,
      b.entry_count,
      b.created_at,
      b.restored_at,
      cu.email AS created_by_email,
      ru.email AS restored_by_email
     FROM cashflow_entry_backups b
     LEFT JOIN users cu ON cu.id = b.created_by_user_id
     LEFT JOIN users ru ON ru.id = b.restored_by_user_id
     WHERE b.id = ? AND b.organization_id = ?`
  )
    .bind(backupId, organizationId)
    .first<CashflowEntryBackupListRow>();

  return insertedRow ?? null;
}

async function restoreCashflowEntryBackup(db: D1Database, backupId: number, organizationId: number, restoredByUserId: number): Promise<number> {
  const backup = await db.prepare(
    `SELECT snapshot_json
     FROM cashflow_entry_backups
     WHERE id = ? AND organization_id = ?`
  )
    .bind(backupId, organizationId)
    .first<{ snapshot_json: string }>();

  if (!backup) {
    throw new Error('Backup not found');
  }

  let parsed: CashflowEntryBackupSnapshotRow[];
  try {
    parsed = JSON.parse(backup.snapshot_json) as CashflowEntryBackupSnapshotRow[];
  } catch {
    throw new Error('Invalid backup snapshot');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid backup snapshot');
  }

  const statements = [
    db.prepare(
      `UPDATE cashflow_entries
       SET deleted_at = datetime('now'),
           updated_at = datetime('now')
       WHERE organization_id = ? AND deleted_at IS NULL`
    ).bind(organizationId),
    ...parsed.map((row) =>
      db.prepare(
        `INSERT INTO cashflow_entries
          (user_id, organization_id, title, amount, type, scheduled_date, order_index, note, account_name,
           actual_transaction_date, customer_name, staff_name, label_color, cf_category, import_source_file_name,
           import_management_no, import_batch_id, is_sample, is_completed, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        row.user_id,
        organizationId,
        row.title,
        row.amount,
        row.type,
        row.scheduled_date,
        row.order_index,
        row.note,
        row.account_name,
        row.actual_transaction_date,
        row.customer_name,
        row.staff_name,
        row.label_color,
        row.cf_category,
        row.import_source_file_name,
        row.import_management_no,
        row.import_batch_id,
        row.is_sample,
        row.is_completed,
        row.created_by_user_id ?? restoredByUserId
      )
    ),
    db.prepare(
      `UPDATE cashflow_entry_backups
       SET restored_at = datetime('now'),
           restored_by_user_id = ?,
           updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`
    ).bind(restoredByUserId, backupId, organizationId)
  ];

  await db.batch(statements);
  return parsed.length;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function formatCashflowStatementHeaderLabel(value: string): string {
  if (/^\d{4}年$/.test(value)) return value;
  const match = value.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (match) return `${match[1]}/${match[2]}`;
  return value;
}

function formatCashflowStatementValue(value: number | string | null): string {
  if (value === null || value === '') return '–';
  if (typeof value === 'number') return new Intl.NumberFormat('ja-JP').format(value);
  return escapeHtml(String(value));
}

function cashflowStatementStatusClass(status: string): string {
  if (status === '実績') return '実績';
  if (status === '計画') return '計画';
  return '合計';
}

function buildCashflowStatementDisplayColumns(startYear: number, endYear: number, now: Date) {
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const columns: Array<{ key: string; yearLabel: string; status: string }> = [];
  for (let year = startYear; year <= endYear; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;
      columns.push({
        key: `m-${monthKey}`,
        yearLabel: `${monthKey}-01 00:00:00`,
        status: monthKey < currentMonthKey ? '実績' : '計画'
      });
    }
  }
  return columns;
}

type CashflowStatementRowValueMap = Map<string, number | string | null>;
type CashflowStatementData = {
  valuesByRowNo: Map<number, CashflowStatementRowValueMap>;
  uncategorizedCount: number;
};

async function loadCashflowStatementData(
  db: D1Database,
  organizationId: number,
  startYear: number,
  endYear: number
): Promise<CashflowStatementData> {
  const result = await db.prepare(
    `SELECT scheduled_date, amount, type, cf_category
     FROM cashflow_entries
     WHERE organization_id = ?
       AND deleted_at IS NULL
       AND scheduled_date < ?
     ORDER BY scheduled_date ASC, order_index ASC, id ASC`
  )
    .bind(organizationId, `${endYear + 1}-01-01`)
    .all<{
      scheduled_date: string;
      amount: number;
      type: 'income' | 'expense';
      cf_category: string | null;
    }>();

  const entries = (result.results ?? [])
    .filter((entry) => parseDateOnly(entry.scheduled_date) !== null)
    .map((entry) => ({
      monthKey: entry.scheduled_date.slice(0, 7),
      amount: Number(entry.amount || 0),
      type: entry.type,
      cfCategory: String(entry.cf_category || '').trim()
    }))
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  const categorizedEntries = entries.filter((entry) => entry.cfCategory !== '');
  const uncategorizedCount = entries.length - categorizedEntries.length;

  if (categorizedEntries.length === 0) {
    return {
      valuesByRowNo: new Map(),
      uncategorizedCount
    };
  }

  const valuesByRowNo = new Map<number, CashflowStatementRowValueMap>();
  const itemRowMonths = new Map<number, Map<string, number>>();
  const openingByMonth = new Map<string, number>();
  const operatingIncomeByMonth = new Map<string, number>();
  const operatingExpenseByMonth = new Map<string, number>();
  const operatingNetByMonth = new Map<string, number>();
  const financingIncomeByMonth = new Map<string, number>();
  const financingExpenseByMonth = new Map<string, number>();
  const financingNetByMonth = new Map<string, number>();
  const closingByMonth = new Map<string, number>();

  const months: string[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      months.push(`${year}-${String(month).padStart(2, '0')}`);
    }
  }

  const addItemRowValue = (rowNo: number, monthKey: string, amount: number) => {
    if (!itemRowMonths.has(rowNo)) itemRowMonths.set(rowNo, new Map());
    const monthMap = itemRowMonths.get(rowNo)!;
    monthMap.set(monthKey, (monthMap.get(monthKey) || 0) + amount);
  };

  const operatingIncomeRowMap = new Map<string, number>([
    ['現金売上', 8],
    ['売掛金回収', 9],
    ['未収入金・前受金入金', 11],
    ['その他の収入', 12],
    ['売電収入（西予発電所）', 13],
    ['売電収入（府中発電所）', 14],
    ['売電収入（茨城発電所）', 15]
  ]);
  const operatingExpenseRowMap = new Map<string, number>([
    ['現金仕入', 17],
    ['買掛金支払', 18],
    ['未払金・前渡金支払', 20],
    ['人件費支出', 21],
    ['家賃等', 22],
    ['固定費', 23],
    ['租税公課', 24],
    ['その他の支出（社長）', 25],
    ['その他の支出（UFJ）', 26],
    ['その他の支出（木下）', 27],
    ['その他の支出（その他）', 28]
  ]);
  const financingIncomeRowMap = new Map<string, number>([
    ['固定性預金払戻し', 32],
    ['銀行借入', 33],
    ['E借入', 36],
    ['売電事業分資金移動', 39],
    ['設備収入（設備売却など）', 40],
    ['その他の財務等収入', 41]
  ]);
  const financingExpenseRowMap = new Map<string, number>([
    ['銀行借入返済', 43],
    ['E借入', 46],
    ['設備支出（固定資産投資）', 49],
    ['その他の財務等支出', 50],
    ['利息保証料支払', 51],
    ['リース債務返済', 52]
  ]);

  let runningBalance = 0;
  let cursor = 0;
  for (const monthKey of months) {
    while (cursor < categorizedEntries.length && categorizedEntries[cursor].monthKey < monthKey) {
      const entry = categorizedEntries[cursor];
      runningBalance += entry.type === 'income' ? entry.amount : -entry.amount;
      cursor += 1;
    }
    openingByMonth.set(monthKey, runningBalance);

    let operatingIncome = 0;
    let operatingExpense = 0;
    let hasOperatingIncomeEntry = false;
    let hasOperatingExpenseEntry = false;
    let financingIncome = 0;
    let financingExpense = 0;
    let hasFinancingIncomeEntry = false;
    let hasFinancingExpenseEntry = false;
    while (cursor < categorizedEntries.length && categorizedEntries[cursor].monthKey === monthKey) {
      const entry = categorizedEntries[cursor];
      if (CASHFLOW_STATEMENT_OPERATING_INCOME_CATEGORIES.has(entry.cfCategory)) {
        operatingIncome += entry.amount;
        hasOperatingIncomeEntry = true;
        const rowNo = operatingIncomeRowMap.get(entry.cfCategory);
        if (rowNo) addItemRowValue(rowNo, monthKey, entry.amount);
      } else if (CASHFLOW_STATEMENT_OPERATING_EXPENSE_CATEGORIES.has(entry.cfCategory)) {
        operatingExpense += entry.amount;
        hasOperatingExpenseEntry = true;
        const rowNo = operatingExpenseRowMap.get(entry.cfCategory);
        if (rowNo) addItemRowValue(rowNo, monthKey, entry.amount);
      }
      if (CASHFLOW_STATEMENT_FINANCING_INCOME_CATEGORIES.has(entry.cfCategory)) {
        financingIncome += entry.amount;
        hasFinancingIncomeEntry = true;
        const rowNo = financingIncomeRowMap.get(entry.cfCategory);
        if (rowNo) addItemRowValue(rowNo, monthKey, entry.amount);
      } else if (CASHFLOW_STATEMENT_FINANCING_EXPENSE_CATEGORIES.has(entry.cfCategory)) {
        financingExpense += entry.amount;
        hasFinancingExpenseEntry = true;
        const rowNo = financingExpenseRowMap.get(entry.cfCategory);
        if (rowNo) addItemRowValue(rowNo, monthKey, entry.amount);
      }
      runningBalance += entry.type === 'income' ? entry.amount : -entry.amount;
      cursor += 1;
    }

    if (hasOperatingIncomeEntry) {
      operatingIncomeByMonth.set(monthKey, operatingIncome);
    }
    if (hasOperatingExpenseEntry) {
      operatingExpenseByMonth.set(monthKey, operatingExpense);
    }
    if (hasOperatingIncomeEntry || hasOperatingExpenseEntry) {
      operatingNetByMonth.set(monthKey, operatingIncome - operatingExpense);
    }
    if (hasFinancingIncomeEntry) {
      financingIncomeByMonth.set(monthKey, financingIncome);
    }
    if (hasFinancingExpenseEntry) {
      financingExpenseByMonth.set(monthKey, financingExpense);
    }
    if (hasFinancingIncomeEntry || hasFinancingExpenseEntry) {
      financingNetByMonth.set(monthKey, financingIncome - financingExpense);
    }
    closingByMonth.set(monthKey, runningBalance);
  }

  for (const [rowNo, monthMap] of itemRowMonths.entries()) {
    valuesByRowNo.set(rowNo, new Map(Array.from(monthMap.entries()).map(([monthKey, value]) => [monthKey, value])));
  }

  valuesByRowNo.set(6, new Map(Array.from(openingByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(7, new Map(Array.from(operatingIncomeByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(16, new Map(Array.from(operatingExpenseByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(29, new Map(Array.from(operatingNetByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(31, new Map(Array.from(financingIncomeByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(42, new Map(Array.from(financingExpenseByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(55, new Map(Array.from(financingNetByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(56, new Map(Array.from(closingByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));

  return { valuesByRowNo, uncategorizedCount };
}

function isCashflowStatementMonthLabel(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(value);
}

function toCashflowStatementMonthKey(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (!match) return value;
  return `${match[1]}-${match[2]}`;
}

function formatCashflowStatementMonthOption(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (!match) return value;
  return `${match[1]}年${String(Number(match[2]))}月`;
}

function sanitizeMonth(month?: string | null): string {
  const m = (month ?? '').trim();
  if (/^\d{4}-\d{2}$/.test(m)) return m;
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseMonth(month?: string | null): string | null {
  const m = (month ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return null;
  return m;
}

function parseYear(year?: string | null): string | null {
  const y = (year ?? '').trim();
  if (!/^\d{4}$/.test(y)) return null;
  return y;
}

function parseDateOnly(date?: string | null): string | null {
  const d = (date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const parsed = new Date(`${d}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== d) return null;
  return d;
}

function toAuditUtcStart(date?: string | null): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00+09:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

function toAuditUtcEndExclusive(date?: string | null): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00+09:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

function parseSlashOrIsoDate(date?: string | null): string | null {
  const raw = (date ?? '').trim();
  if (!raw) return null;
  const iso = parseDateOnly(raw);
  if (iso) return iso;
  const m = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return parseDateOnly(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
}

function parseNullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function decodeShiftJisLike(bytes: Uint8Array): string {
  const candidates = ['windows-31j', 'utf-8', 'shift_jis'] as const;
  const headerHints = ['入出金管理No', '案件名', '予定日', 'ID', '区分', '件名', '金額'];
  let bestText = '';
  let bestScore = -1;

  try {
    for (const encoding of candidates) {
      try {
        const text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
        const score = headerHints.reduce((sum, hint) => sum + (text.includes(hint) ? 1 : 0), 0);
        if (score > bestScore) {
          bestText = text;
          bestScore = score;
        }
      } catch (error) {
        console.error(`decode failed for ${encoding}, continue fallback`, error);
      }
    }
    if (bestText) return bestText;
  } catch (error) {
    console.error('multi-encoding decode failed, fallback to utf-8. Error details:', error);
  }

  return new TextDecoder().decode(bytes);
}

function parseCsvLineSimple(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseRakurakuCsvText(text: string): Array<{
  managementNo?: string;
  projectName?: string;
  expenseTotalInclTax?: number | null;
  incomeTotalInclTax?: number | null;
  customerName?: string;
  scheduledDateRaw?: string;
}> {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((v) => v.trim() !== '');
  if (lines.length === 0) {
    throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.csvEmpty, 'CSVファイルが空です。');
  }
  if (lines.length === 1) {
    throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.csvEmpty, 'CSVデータ行がありません。');
  }
  const header = parseCsvLineSimple(lines[0].replace(/^\uFEFF/, ''));
  const idx = {
    managementNo: header.indexOf('入出金管理No'),
    projectName: header.indexOf('案件名'),
    expense: header.indexOf('出金合計(税込)'),
    income: header.indexOf('入金合計(税込)'),
    customerName: header.indexOf('顧客名'),
    scheduledDate: header.indexOf('予定日')
  };
  if (Object.values(idx).some((n) => n < 0)) {
    throw new CsvImportParseError(
      CSV_IMPORT_ERROR_CODES.csvHeaderMismatch,
      'CSVヘッダーが想定形式と一致しません。楽々販売の標準CSVを利用してください。'
    );
  }

  const rows: Array<{
    managementNo?: string;
    projectName?: string;
    expenseTotalInclTax?: number | null;
    incomeTotalInclTax?: number | null;
    customerName?: string;
    scheduledDateRaw?: string;
  }> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLineSimple(lines[i]);
    rows.push({
      managementNo: String(cols[idx.managementNo] ?? '').trim(),
      projectName: String(cols[idx.projectName] ?? '').trim(),
      expenseTotalInclTax: parseNullableInt(String(cols[idx.expense] ?? '').replaceAll(',', '')),
      incomeTotalInclTax: parseNullableInt(String(cols[idx.income] ?? '').replaceAll(',', '')),
      customerName: String(cols[idx.customerName] ?? '').trim(),
      scheduledDateRaw: String(cols[idx.scheduledDate] ?? '').trim()
    });
  }
  return rows;
}

function parseLimit(limitRaw?: string | null): number | null {
  const raw = (limitRaw ?? '').trim();
  if (raw === '') return 100;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) return null;
  return value;
}

function enumerateMonths(start: string, end: string): string[] {
  const [startYear, startMonth] = start.split('-').map((n) => Number(n));
  const [endYear, endMonth] = end.split('-').map((n) => Number(n));
  const result: string[] = [];
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    result.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return result;
}

function isValidDate(input?: string): input is string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
  const d = new Date(`${input}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === input;
}

function isValidType(type: unknown): type is 'income' | 'expense' {
  return type === 'income' || type === 'expense';
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isStrongPassword(password: string): boolean {
  if (password.length < 10 || password.length > 128) return false;
  return /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

async function parseJsonBody<T>(c: { req: { json: <U>() => Promise<U> } }): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

function isValidEntryInput(input: {
  title: string;
  note: string;
  amount: unknown;
  type: unknown;
  scheduledDate: unknown;
  accountName: string;
  customerName: string;
  staffName: string;
  labelColor: string;
  cfCategory: string;
}, allowedCfCategories?: Set<string>): input is {
  title: string;
  note: string;
  amount: number;
  type: 'income' | 'expense';
  scheduledDate: string;
  accountName: string;
  customerName: string;
  staffName: string;
  labelColor: string;
  cfCategory: string;
} {
  const allowedAccounts = new Set(['', '三井住友口座', '和気口座', '那須口座']);
  const allowedColors = new Set<string>(ENTRY_LABEL_COLORS);
  const categories = allowedCfCategories ?? new Set<string>(CF_CATEGORIES);
  return (
    input.title.length > 0 &&
    input.title.length <= MAX_TITLE_LENGTH &&
    input.note.length <= MAX_NOTE_LENGTH &&
    allowedAccounts.has(input.accountName) &&
    input.accountName.length <= 80 &&
    input.customerName.length <= 80 &&
    input.staffName.length <= 80 &&
    allowedColors.has(input.labelColor) &&
    categories.has(input.cfCategory) &&
    Number.isInteger(input.amount) &&
    Number(input.amount) >= MIN_AMOUNT &&
    Number(input.amount) <= MAX_AMOUNT &&
    isValidType(input.type) &&
    isValidDate(typeof input.scheduledDate === 'string' ? input.scheduledDate : undefined)
  );
}

function renderCfCategoryOptions(selected: string, entryType: string): string {
  const categories = getCfCategoriesByEntryType(entryType);
  return ['', ...categories].map((category) => {
    const label = category === '' ? '未設定' : category;
    return `<option value="${escapeHtml(category)}"${category === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

function buildCfCategoryOptionsHtml(selected: string, entryType: string): string {
  const categories = getCfCategoriesByEntryType(entryType);
  return ['', ...categories].map((category) => {
    const label = category === '' ? 'CF:未設定' : `CF:${category}`;
    return '<option value="' + escapeHtml(category) + '"' + (category === selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }).join('');
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  let state = enc.encode(`${salt}:${password}`);

  // Cloudflare Workers runtime 互換性を優先した反復SHA-256
  for (let i = 0; i < 120_000; i += 1) {
    const digest = await crypto.subtle.digest('SHA-256', state);
    state = new Uint8Array(digest);
  }

  return [...state].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPasswordPbkdf2(password: string, salt: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(salt),
      iterations: 310_000
    },
    keyMaterial,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password: string, salt: string, expectedHash: string, algoRaw?: string | null): Promise<boolean> {
  const algo = (algoRaw ?? PASSWORD_ALGO_LEGACY).trim();
  if (algo === PASSWORD_ALGO_PBKDF2) {
    try {
      const calculated = await hashPasswordPbkdf2(password, salt);
      return constantTimeEqual(calculated, expectedHash);
    } catch (err) {
      console.error('pbkdf2 verify failed', err);
      return false;
    }
  }
  const calculated = await hashPassword(password, salt);
  return constantTimeEqual(calculated, expectedHash);
}

async function getLoginBlockedUntil(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT blocked_until
     FROM login_rate_limits
     WHERE key = ?`
  ).bind(key).first<{ blocked_until: string | null }>();
  return row?.blocked_until ?? null;
}

async function recordLoginFailure(db: D1Database, key: string): Promise<void> {
  const now = Date.now();
  const row = await db.prepare(
    `SELECT fail_count, first_failed_at
     FROM login_rate_limits
     WHERE key = ?`
  ).bind(key).first<{ fail_count: number; first_failed_at: string }>();

  if (!row) {
    await db.prepare(
      `INSERT INTO login_rate_limits (key, fail_count, first_failed_at, blocked_until, updated_at)
       VALUES (?, 1, ?, NULL, ?)`
    ).bind(key, new Date(now).toISOString(), new Date(now).toISOString()).run();
    return;
  }

  const firstFailedMs = Date.parse(row.first_failed_at);
  const inWindow = Number.isFinite(firstFailedMs) && now - firstFailedMs <= LOGIN_RATE_LIMIT_WINDOW_MS;
  const nextCount = inWindow ? Number(row.fail_count) + 1 : 1;
  const nextFirstFailedAt = inWindow ? row.first_failed_at : new Date(now).toISOString();
  const blockedUntil = nextCount >= LOGIN_RATE_LIMIT_MAX_FAILURES
    ? new Date(now + LOGIN_RATE_LIMIT_BLOCK_MS).toISOString()
    : null;

  await db.prepare(
    `UPDATE login_rate_limits
     SET fail_count = ?, first_failed_at = ?, blocked_until = ?, updated_at = ?
     WHERE key = ?`
  ).bind(nextCount, nextFirstFailedAt, blockedUntil, new Date(now).toISOString(), key).run();
}

async function clearLoginFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM login_rate_limits WHERE key = ?').bind(key).run();
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function runScheduledCashflowEntryBackups(db: D1Database): Promise<{ created: number; skipped: number }> {
  const orgRows = await db.prepare(
    `SELECT id
     FROM organizations
     ORDER BY id ASC`
  ).all<{ id: number }>();

  let created = 0;
  let skipped = 0;
  for (const org of orgRows.results ?? []) {
    const backup = await createCashflowEntryBackup(db, org.id, null, 'scheduled');
    if (backup) {
      created += 1;
    } else {
      skipped += 1;
    }
  }
  await pruneCashflowEntryBackups(db);
  return { created, skipped };
}

export async function scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
  try {
    const result = await runScheduledCashflowEntryBackups(env.DB);
    console.log('cashflow backup scheduled job completed', result);
  } catch (error) {
    console.error('cashflow backup scheduled job failed', error);
  }
}

export default app;
