import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Env = {
  DB: D1Database;
};

type User = { id: number; email: string; isAdmin: boolean; organizationId: number | null };

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

app.get('/audit', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login');
  if (!user.isAdmin) return c.text('Forbidden', 403);
  return c.html(renderAuditPage(user.email));
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
     WHERE organization_id = ? AND deleted_at IS NULL AND is_completed = 1 AND type = 'expense' AND substr(scheduled_date, 1, 4) = ?
     ORDER BY scheduled_date ASC, order_index ASC, id ASC`
  )
    .bind(organizationId, year)
    .all<{ id: number; scheduled_date: string; title: string; amount: number; note: string | null; type: 'expense' }>();

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
       AND (? IS NULL OR login_at < datetime(?, '+1 day'))
     ORDER BY l.login_at DESC
     LIMIT 500`
  )
    .bind(email, email, from, from, to, to)
    .all<{ login_at: string; logout_at: string | null; logout_reason: string | null; session_token_masked: string; user_email: string }>();

  return c.json({ logs: rows.results ?? [] });
});

app.get('/api/audit/operation-logs', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.isAdmin) return c.json({ error: 'Forbidden' }, 403);
  const from = parseDateOnly(c.req.query('from'));
  const to = parseDateOnly(c.req.query('to'));
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
       AND (? IS NULL OR o.created_at < datetime(?, '+1 day'))
     ORDER BY o.created_at DESC
     LIMIT 1000`
  )
    .bind(email, email, action, action, from, from, to, to)
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
    `SELECT id, title, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, is_sample, is_completed, created_by_user_id, import_management_no
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
  }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const accountName = typeof body.accountName === 'string' ? body.accountName.trim() : '';
  const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : '';
  const staffName = typeof body.staffName === 'string' ? body.staffName.trim() : '';
  const labelColor = typeof body.labelColor === 'string' ? body.labelColor.trim() : '';

  const validatedInput = {
    title,
    note,
    amount: body.amount,
    type: body.type,
    scheduledDate: body.scheduledDate,
    accountName,
    customerName,
    staffName,
    labelColor
  };
  if (!isValidEntryInput(validatedInput)) {
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
      (user_id, organization_id, title, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, is_sample, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
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

  const isD1ConstraintError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const normalized = message.toLowerCase();
    return normalized.includes('constraint') || normalized.includes('unique');
  };
  const isD1BindLimitError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const normalized = message.toLowerCase();
    return normalized.includes('too many sql variables') || normalized.includes('bind') && normalized.includes('too many');
  };

  let sourceFileName = 'browser_upload.csv';
  let syncEntries = true;
  const rowErrors: Array<{ rowNumber: number; errorCode: CsvImportErrorCode; message: string }> = [];
  let incomingRows: Array<{
    managementNo?: string;
    projectName?: string;
    expenseTotalInclTax?: number | null;
    incomeTotalInclTax?: number | null;
    customerName?: string;
    scheduledDateRaw?: string;
    scheduledDate?: string;
  }> = [];
  const errorResponse = (
    status: 400 | 401 | 403 | 415 | 500,
    errorCode: CsvImportErrorCode,
    message: string,
    extra: Record<string, unknown> = {}
  ) => c.json({ ok: false, errorCode, error: message, message, ...extra }, status);

  try {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch (error) {
        console.error('rakuraku import multipart parse failed', { userId: user.id, contentType, error });
        return errorResponse(400, CSV_IMPORT_ERROR_CODES.multipartParseFailed, 'multipart/form-data の解析に失敗しました。CSVファイルを再選択して再実行してください。');
      }
      const file = form.file;
      const syncRaw = String(form.syncEntries ?? 'true').toLowerCase();
      syncEntries = syncRaw !== 'false' && syncRaw !== '0';
      if (!(file instanceof File)) {
        return errorResponse(400, CSV_IMPORT_ERROR_CODES.fileMissing, 'CSVファイルがありません。');
      }
      sourceFileName = String(file.name || sourceFileName).slice(0, 200);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const text = decodeShiftJisLike(bytes);
        incomingRows = parseRakurakuCsvText(text);
      } catch (error) {
        console.error('rakuraku import csv decode/parse failed', { userId: user.id, sourceFileName, error });
        if (error instanceof CsvImportParseError) {
          return errorResponse(400, error.code, error.message);
        }
        return errorResponse(400, CSV_IMPORT_ERROR_CODES.fileDecodeFailed, 'CSVファイルの解析に失敗しました。形式を確認してください。');
      }
    } else if (contentType.includes('application/json')) {
      let body: {
        sourceFileName?: string;
        syncEntries?: boolean;
        rows?: Array<{
          managementNo?: string;
          projectName?: string;
          expenseTotalInclTax?: number | null;
          incomeTotalInclTax?: number | null;
          customerName?: string;
          scheduledDateRaw?: string;
          scheduledDate?: string;
        }>;
      } | null = null;
      try {
        body = await parseJsonBody(c);
      } catch (error) {
        console.error('rakuraku import invalid json body', { userId: user.id, error });
        return errorResponse(400, CSV_IMPORT_ERROR_CODES.invalidJson, 'JSON ボディの解析に失敗しました。');
      }
      if (!body || !Array.isArray(body.rows)) {
        return errorResponse(400, CSV_IMPORT_ERROR_CODES.invalidJson, 'JSON ボディの形式が不正です。');
      }
      sourceFileName = String(body.sourceFileName ?? sourceFileName).slice(0, 200);
      syncEntries = Boolean(body.syncEntries);
      incomingRows = body.rows;
    } else {
      return errorResponse(415, CSV_IMPORT_ERROR_CODES.unsupportedContentType, 'サポート対象外の Content-Type です。multipart/form-data または application/json を使用してください。');
    }

    const batchId = `web_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
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
      return errorResponse(400, CSV_IMPORT_ERROR_CODES.noImportableRows, '取り込み可能な行がありません。', { importedRows: 0, invalidRows });
    }

    // Always process all parsed rows so re-import can update existing entries.
    const freshRows = preparedRows;
    let duplicateRows = 0;

    const monthSet = new Set(freshRows.map((r) => r.scheduledDate.slice(0, 7)));
    const monthList = [...monthSet];
    const orderMap = new Map<string, number>();
    if (syncEntries && monthList.length > 0) {
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

    const managementNos = [...new Set(freshRows.map((r) => r.managementNo.trim()).filter((v) => v !== ''))];
    const existingByKey = new Map<string, { id: number; order_index: number; type: 'income' | 'expense' }>();
    if (syncEntries && managementNos.length > 0) {
      const keyChunkSize = 80;
      for (let i = 0; i < managementNos.length; i += keyChunkSize) {
        const part = managementNos.slice(i, i + keyChunkSize);
        const placeholders = part.map(() => '?').join(', ');
        const existingEntries = await c.env.DB.prepare(
          `SELECT id, import_management_no, type, order_index
           FROM cashflow_entries
           WHERE organization_id = ? AND deleted_at IS NULL AND import_management_no IN (${placeholders})`
        ).bind(organizationId, ...part).all<{ id: number; import_management_no: string; type: 'income' | 'expense'; order_index: number }>();
        for (const row of existingEntries.results ?? []) {
          const key = `${String(row.import_management_no)}::${row.type}`;
          if (!existingByKey.has(key)) {
            existingByKey.set(key, { id: Number(row.id), order_index: Number(row.order_index ?? 0), type: row.type });
          }
        }
      }
    }

    const rowGroups: Array<{ rowNumber: number; statements: D1PreparedStatement[]; entryCount: number; updatedCount: number }> = [];
    for (const row of freshRows) {
      const statements: D1PreparedStatement[] = [];
      let entryCount = 0;
      let updatedCount = 0;
      statements.push(
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO rakuraku_cashflow_import_rows
            (user_id, import_batch_id, source_file_name, row_number, management_no, project_name, expense_total_incl_tax, income_total_incl_tax, customer_name, scheduled_date, scheduled_date_raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          user.id,
          batchId,
          sourceFileName,
          row.rowNumber,
          row.managementNo || null,
          row.projectName || null,
          row.expense,
          row.income,
          row.customerName || null,
          row.scheduledDate,
          row.scheduledDateRaw || null
        )
      );

      if (syncEntries) {
        const month = row.scheduledDate.slice(0, 7);
        let nextOrder = Number(orderMap.get(month) ?? 0);
        const title = (row.projectName || row.managementNo || row.customerName || '楽々販売取込').slice(0, 120);
        if (row.income !== null && row.income > 0) {
          const managementNo = row.managementNo.trim();
          const existingKey = managementNo ? `${managementNo}::income` : '';
          const existing = existingKey ? existingByKey.get(existingKey) : undefined;
          if (existing) {
            statements.push(
              c.env.DB.prepare(
                `UPDATE cashflow_entries
                 SET title = ?, amount = ?, scheduled_date = ?, customer_name = ?, updated_at = datetime('now'),
                     import_source_file_name = ?, import_batch_id = ?
                 WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
              ).bind(
                title,
                row.income,
                row.scheduledDate,
                row.customerName || null,
                sourceFileName,
                batchId,
                existing.id,
                organizationId
              )
            );
            updatedCount += 1;
          } else {
            nextOrder += 1;
            statements.push(
              c.env.DB.prepare(
                `INSERT INTO cashflow_entries
                  (user_id, organization_id, title, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, is_sample, is_completed, created_by_user_id, import_source_file_name, import_management_no, import_batch_id)
                 VALUES (?, ?, ?, ?, 'income', ?, ?, NULL, NULL, NULL, ?, NULL, '', 0, 0, ?, ?, ?, ?)`
              ).bind(
                user.id,
                organizationId,
                title,
                row.income,
                row.scheduledDate,
                nextOrder,
                row.customerName || null,
                user.id,
                sourceFileName,
                row.managementNo || null,
                batchId
              )
            );
            entryCount += 1;
            if (existingKey) existingByKey.set(existingKey, { id: -1, order_index: nextOrder, type: 'income' });
          }
        }
        if (row.expense !== null && row.expense > 0) {
          const managementNo = row.managementNo.trim();
          const existingKey = managementNo ? `${managementNo}::expense` : '';
          const existing = existingKey ? existingByKey.get(existingKey) : undefined;
          if (existing) {
            statements.push(
              c.env.DB.prepare(
                `UPDATE cashflow_entries
                 SET title = ?, amount = ?, scheduled_date = ?, customer_name = ?, updated_at = datetime('now'),
                     import_source_file_name = ?, import_batch_id = ?
                 WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
              ).bind(
                title,
                row.expense,
                row.scheduledDate,
                row.customerName || null,
                sourceFileName,
                batchId,
                existing.id,
                organizationId
              )
            );
            updatedCount += 1;
          } else {
            nextOrder += 1;
            statements.push(
              c.env.DB.prepare(
                `INSERT INTO cashflow_entries
                  (user_id, organization_id, title, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, is_sample, is_completed, created_by_user_id, import_source_file_name, import_management_no, import_batch_id)
                 VALUES (?, ?, ?, ?, 'expense', ?, ?, NULL, NULL, NULL, ?, NULL, '', 0, 0, ?, ?, ?, ?)`
              ).bind(
                user.id,
                organizationId,
                title,
                row.expense,
                row.scheduledDate,
                nextOrder,
                row.customerName || null,
                user.id,
                sourceFileName,
                row.managementNo || null,
                batchId
              )
            );
            entryCount += 1;
            if (existingKey) existingByKey.set(existingKey, { id: -1, order_index: nextOrder, type: 'expense' });
          }
        }
        orderMap.set(month, nextOrder);
      }
      rowGroups.push({ rowNumber: row.rowNumber, statements, entryCount, updatedCount });
    }

    let importedRows = 0;
    let insertedEntries = 0;
    let updatedEntries = 0;
    let failedRows = 0;
    const writeChunkSize = 40;
    for (let i = 0; i < rowGroups.length; i += writeChunkSize) {
      const chunk = rowGroups.slice(i, i + writeChunkSize);
      const flattened = chunk.flatMap((g) => g.statements);
      try {
        await c.env.DB.batch(flattened);
        importedRows += chunk.length;
        insertedEntries += chunk.reduce((sum, g) => sum + g.entryCount, 0);
        updatedEntries += chunk.reduce((sum, g) => sum + g.updatedCount, 0);
      } catch (error) {
        const mode = isD1ConstraintError(error) ? 'constraint' : 'general';
        console.error('rakuraku import chunk failed fallback to row-by-row', {
          userId: user.id,
          sourceFileName,
          batchId,
          chunkRows: chunk.length,
          mode,
          error
        });
        for (const group of chunk) {
          try {
            await c.env.DB.batch(group.statements);
            importedRows += 1;
            insertedEntries += group.entryCount;
            updatedEntries += group.updatedCount;
          } catch (rowError) {
            if (isD1ConstraintError(rowError)) {
              duplicateRows += 1;
            } else {
              failedRows += 1;
              rowErrors.push({
                rowNumber: group.rowNumber,
                errorCode: CSV_IMPORT_ERROR_CODES.rowDbWriteFailed,
                message: 'DB書き込みに失敗しました。'
              });
            }
            console.error('rakuraku import row failed in non-constraint fallback', {
              userId: user.id,
              sourceFileName,
              batchId,
              rowNumber: group.rowNumber,
              error: rowError
            });
          }
        }
      }
    }

    const ok = importedRows > 0 || duplicateRows > 0;
    return c.json({
      ok: true,
      importedRows,
      invalidRows,
      duplicateRows,
      failedRows,
      rowErrors: rowErrors.slice(0, 50),
      insertedEntries,
      updatedEntries,
      batchId,
      message: ok
        ? (failedRows > 0 ? `一部失敗 ${failedRows} 件をスキップして取り込みました。` : '取り込みが完了しました。')
        : '取り込み対象がありませんでした。'
    });
  } catch (error) {
    if (isD1BindLimitError(error)) {
      return errorResponse(
        400,
        CSV_IMPORT_ERROR_CODES.queryBindLimitExceeded,
        'CSV件数が多くクエリ上限を超えました。ファイルを分割して再実行してください。'
      );
    }
    console.error('rakuraku import failed', {
      userId: user.id,
      sourceFileName,
      error
    });
    return errorResponse(500, CSV_IMPORT_ERROR_CODES.internalError, 'CSV取り込み中にエラーが発生しました。時間をおいて再実行してください。');
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
    .head-wrap { max-width: 1520px; margin: 0 auto; display: grid; grid-template-columns: 220px 1fr auto; gap: 18px; align-items: center; }
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
    .header-warning-slot { max-width: 1520px; margin: 8px auto 0; padding: 0 20px; min-height: 34px; }
    .balance-alert { opacity: 0; transform: translateY(-2px); transition: opacity .15s ease, transform .15s ease; font-size: 12px; font-weight: 700; color: #7a5300; background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; padding: 8px 10px; pointer-events: none; }
    .balance-alert.show { opacity: 1; transform: translateY(0); }

    .main { max-width: 1520px; margin: 18px auto; padding: 0 20px 40px; }
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
    table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 1320px; background: #fff; }
    th, td { border-bottom: 1px solid #e7edf4; text-align: left; padding: 9px 8px; vertical-align: middle; }
    th { position: sticky; top: 0; z-index: 2; background: #f5f8fb; color: #334e68; font-weight: 700; }
    tbody tr:hover { background: #fbfdff; }
    tbody tr.completed { background: #f2f4f7; color: #7b8794; }
    tbody tr.completed .amount,
    tbody tr.completed .running { color: #7b8794 !important; }
    .amount { font-variant-numeric: tabular-nums; font-weight: 700; }
    .amount.income { color: var(--income); }
    .amount.expense { color: var(--expense); }
    .running.plus { color: var(--income); font-weight: 700; }
    .running.minus { color: var(--expense); font-weight: 700; }
    #list-section-body th:nth-child(4),
    #list-section-body td:nth-child(4) { white-space: nowrap; min-width: 110px; }
    #list-section-body th:nth-child(5),
    #list-section-body td:nth-child(5) { white-space: nowrap; min-width: 72px; }
    #list-section-body th:nth-child(9),
    #list-section-body td:nth-child(9) { white-space: nowrap; min-width: 110px; }
    #list-section-body th:nth-child(13),
    #list-section-body td:nth-child(13) { white-space: nowrap; min-width: 250px; }
    .actions { display: flex; flex-direction: column; gap: 4px; min-width: 210px; }
    .select-cell { text-align: center; width: 52px; }
    .toggle-cell { text-align: center; width: 42px; }
    .toggle-mgmt { width: 24px; height: 24px; border-radius: 999px; padding: 0; line-height: 22px; font-weight: 700; }
    .detail-row td { background: #f8fbff; color: #3a4a5e; font-size: 12px; }
    .bulk-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .bulk-bar .muted { font-size: 12px; }
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
      <a href="/fiscal" style="display:inline-block; padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.35); color:#fff; text-decoration:none; font-size:13px;">年間サマリー</a>
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
      <strong>年間出金データ（明細）</strong>
      <span class="muted">選択中の年の確定済み出金データを表示します。残高は0起点で計算します。</span>
      <button id="toggle-annual" class="section-toggle" type="button">展開する</button>
    </div>
    <div id="annual-section-body" class="table-wrap collapsed">
      <table>
        <thead><tr><th>日付</th><th>件名</th><th>金額</th><th>メモ</th><th>残高</th></tr></thead>
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
      <button id="import-rakuraku-csv" type="button">CSV読み込み</button>
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
      <span id="list-filter-caption" class="muted"></span>
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
        <thead><tr><th></th><th>#</th><th>ラベル</th><th>予定日</th><th>区分</th><th>件名</th><th>金額</th><th>メモ</th><th>入出金日</th><th>顧客名</th><th>担当</th><th>残高</th><th>操作</th><th>選択</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </section>
</main>

<script>
  const yearInput = document.getElementById('year');
  const fixedMonth = String(new Date().getMonth() + 1).padStart(2, '0');
  const monthCaption = document.getElementById('month-caption');
  const rowsEl = document.getElementById('rows');
  const form = document.getElementById('entry-form');
  const statusBanner = document.getElementById('status-banner');
  const submitBtn = document.getElementById('submit-btn');
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
    return '';
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
    balanceAlertEl.textContent = '警告: 今月の差引がマイナスです。資金繰りを確認してください。';
    balanceAlertEl.classList.toggle('show', balance < 0);
  }

  function updateSelectedMonthAlert() {
    const monthFilter = String(listFilterMonthEl?.value || 'all');
    if (monthFilter === 'all') {
      const monthBalances = new Map();
      for (let m = 1; m <= 12; m += 1) {
        monthBalances.set(String(m).padStart(2, '0'), 0);
      }
      for (const e of entries) {
        const mm = String(e.scheduled_date || '').slice(5, 7);
        if (!monthBalances.has(mm)) continue;
        const amount = Number(e.amount || 0);
        monthBalances.set(mm, Number(monthBalances.get(mm) || 0) + (e.type === 'income' ? amount : -amount));
      }
      const negativeMonths = Array.from(monthBalances.entries())
        .filter(([, balance]) => balance < 0)
        .map(([mm]) => String(Number(mm)) + '月');
      if (negativeMonths.length > 0) {
        balanceAlertEl.textContent = '警告: 差引がマイナスの月があります（' + negativeMonths.join(' / ') + '）。資金繰りを確認してください。';
        balanceAlertEl.classList.add('show');
      } else {
        balanceAlertEl.textContent = '警告: 今月の差引がマイナスです。資金繰りを確認してください。';
        balanceAlertEl.classList.remove('show');
      }
      return;
    }

    const monthEntries = entries.filter((e) => String(e.scheduled_date || '').slice(5, 7) === monthFilter);
    const balance = monthEntries.reduce((sum, e) => {
      const amount = Number(e.amount || 0);
      return sum + (e.type === 'income' ? amount : -amount);
    }, 0);
    const monthLabel = String(Number(monthFilter));
    balanceAlertEl.textContent = '警告: ' + monthLabel + '月の差引がマイナスです。資金繰りを確認してください。';
    balanceAlertEl.classList.toggle('show', balance < 0);
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

      if (!summaryRes.ok || !entriesRes.ok || !annualRes.ok || !openingRes.ok) {
        throw new Error('読み込み失敗');
      }

      const summary = await summaryRes.json();
      const entriesPayload = await entriesRes.json();
      const openingPayload = await openingRes.json();
      const annualPayload = await annualRes.json();
      entries = Array.isArray(entriesPayload.entries) ? entriesPayload.entries : [];
      openingBalance = Number(openingPayload.openingBalance || 0);
      syncMonthFilterOptions();

      updateSummary(summary);
      renderRows();
      updateSelectedMonthAlert();
      renderAnnualExpenses(Array.isArray(annualPayload.entries) ? annualPayload.entries : []);
    } catch (err) {
      showBanner(statusBanner, 'error', '一覧の取得に失敗しました。通信状態を確認して再読み込みしてください。');
    }
  }

  function renderAnnualExpenses(rows) {
    if (rows.length === 0) {
      annualExpenseRowsEl.innerHTML = '<tr><td colspan="5" class="muted">この年のデータはありません。</td></tr>';
      return;
    }
    let annualRunning = 0;
    annualExpenseRowsEl.innerHTML = rows.map((e) => {
      const amount = Number(e.amount || 0);
      annualRunning -= amount;
      return '<tr>' +
      '<td>' + escapeHtml(e.scheduled_date) + '</td>' +
      '<td>' + escapeHtml(e.title || '') + '</td>' +
      '<td class="amount expense">-' + fmt.format(amount) + '</td>' +
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
      rowsEl.innerHTML = '<tr><td colspan="14" class="muted">データがありません。上のフォームから予定を追加してください。</td></tr>';
      listFilterCaptionEl.textContent = '';
      updateBulkSelectionCaption();
      return;
    }

    const filtered = getFilteredEntries();

    listFilterCaptionEl.textContent = filtered.length === entries.length
      ? '全件表示'
      : String(filtered.length) + ' / ' + String(entries.length) + '件を表示';

    if (filtered.length === 0) {
      rowsEl.innerHTML = '<tr><td colspan="14" class="muted">絞り込み条件に一致する予定はありません。</td></tr>';
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
        ? '<tr class="detail-row"><td></td><td colspan="13">入出金管理No: ' + escapeHtml(String(e.import_management_no || '')) + '</td></tr>'
        : '';

      return '<tr' + rowClass + '>' +
        '<td class="toggle-cell">' + toggleButton + '</td>' +
        '<td>' + (idx + 1) + '</td>' +
        '<td>' +
          '<span class="label-dot label-' + escapeHtml(String(e.label_color || 'blue')) + '"></span>' +
          (Number(e.is_sample) === 1 ? '<span class="muted">サンプル</span>' : '') +
        '</td>' +
        '<td>' + escapeHtml(e.scheduled_date) + '</td>' +
        '<td>' + (e.type === 'income' ? '入金' : '出金') + '</td>' +
        '<td>' + escapeHtml(e.title) + '</td>' +
        '<td class="amount ' + e.type + '">' + (e.type === 'income' ? '+' : '-') + fmt.format(amount) + '</td>' +
        '<td>' + escapeHtml(e.note || '') + '</td>' +
        '<td>' + escapeHtml(e.actual_transaction_date || '') + '</td>' +
        '<td>' + escapeHtml(e.customer_name || '') + '</td>' +
        '<td>' + escapeHtml(e.staff_name || '') + '</td>' +
        '<td class="running ' + runningClass + '">' + (entryRunning > 0 ? '+' : '') + fmt.format(entryRunning) + '</td>' +
        '<td class="actions">' +
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
        '<td class="select-cell"><input type="checkbox" data-select-id="' + e.id + '"' + (selectedEntryIds.has(Number(e.id)) ? ' checked' : '') + ' /></td>' +
      '</tr>' + detailRow;
    }).join('');
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
      labelColor: String(fd.get('labelColor') || 'blue').trim()
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
  importRakurakuCsvBtn.addEventListener('click', async () => {
    const file = rakurakuCsvFileInput && rakurakuCsvFileInput.files ? rakurakuCsvFileInput.files[0] : null;
    if (!file) {
      showBanner(statusBanner, 'warn', 'CSVファイルを選択してください。');
      return;
    }
    importRakurakuCsvBtn.disabled = true;
    const previousLabel = importRakurakuCsvBtn.textContent;
    importRakurakuCsvBtn.textContent = '取り込み中...';
    showBanner(statusBanner, 'warn', 'CSVを取り込み中です。しばらくお待ちください。');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('syncEntries', 'true');
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
          buildApiErrorMessage(payload, rawBody, 'CSV取り込みに失敗しました。')
        );
        return;
      }
      showBanner(
        statusBanner,
        'ok',
        'CSV取込完了: 取込' + String(payload.importedRows || 0) + '件 / 重複' + String(payload.duplicateRows || 0) + '件 / 無効' + String(payload.invalidRows || 0) + '件 / 失敗' + String(payload.failedRows || 0) + '件 / 予定追加' + String(payload.insertedEntries || 0) + '件'
      );
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', 'CSV読み込み中にエラーが発生しました。');
    } finally {
      importRakurakuCsvBtn.disabled = false;
      importRakurakuCsvBtn.textContent = previousLabel || 'CSV読み込み';
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

  exportCsvBtn?.addEventListener('click', () => {
    const filtered = getFilteredEntries();
    if (filtered.length === 0) {
      showBanner(statusBanner, 'warn', '出力するデータがありません。');
      return;
    }
    const headers = ['#', '予定日', '区分', '件名', '金額', 'メモ', '入出金日', '顧客名', '担当社員名', '完了状態', 'ラベル', '管理番号'];
    const rows = filtered.map((e, idx) => [
      idx + 1,
      e.scheduled_date || '',
      e.type === 'income' ? '入金' : '出金',
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
    ].join('\r\n');
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
    .k{font-size:12px;color:var(--muted)}
    .v{font-weight:800;font-size:28px;font-variant-numeric:tabular-nums}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .chart-title{font-weight:700;font-size:20px;margin:0 0 8px}
    svg{width:100%;height:auto;display:block}
    .legend{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}
    .dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:5px}
    .tip{position:fixed;z-index:60;pointer-events:none;background:#0f172a;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.4;box-shadow:0 8px 24px rgba(2,6,23,.25);opacity:0;transform:translateY(4px);transition:.12s ease}
    .tip.show{opacity:1;transform:translateY(0)}
    .sr{position:absolute;left:-9999px}
    @media (max-width:980px){.head{grid-template-columns:1fr}.filters{justify-content:flex-start}.grid{grid-template-columns:1fr}.hero{grid-template-columns:1fr 1fr}}
    @media (max-width:620px){.hero{grid-template-columns:1fr}.v{font-size:24px}}
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
      ${isAdmin ? '<a href="/audit" style="display:inline-flex;align-items:center;padding:9px 10px;border:1px solid #b9c8d9;border-radius:8px;background:#fff;color:#1d2733;text-decoration:none;font-size:14px;">監査ログ</a>' : ''}
      <select id="start-month" aria-label="開始月"></select>
      <select id="end-month" aria-label="終了月"></select>
      <button id="reload">更新</button>
    </div>
  </header>
  <section class="hero" aria-label="意思決定サマリーカード">
    <article class="card"><div class="k">総入金</div><div id="sum-in" class="v">0</div></article>
    <article class="card"><div class="k">総出金</div><div id="sum-out" class="v">0</div></article>
    <article class="card"><div class="k">差引</div><div id="sum-net" class="v">0</div></article>
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
  document.getElementById('sum-net').textContent = (net>=0?'+':'-')+'¥'+fmt.format(Math.abs(net));
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

  function esc(s){return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\"','&quot;').replaceAll(\"'\",'&#39;');}

  function initDates(){
    const now = new Date();
    const to = now.toISOString().slice(0,10);
    const fromDate = new Date(now.getTime() - 29*24*60*60*1000);
    const from = fromDate.toISOString().slice(0,10);
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
      '<tr><td>' + esc(r.user_email || '-') + '</td><td>' + esc(r.login_at) + '</td><td>' + esc(r.logout_at || '-') + '</td><td>' + esc(r.logout_reason || '-') + '</td><td class=\"muted\">' + esc(r.session_token_masked || '-') + '</td></tr>'
    ).join('') : '<tr><td colspan=\"5\" class=\"muted\">履歴がありません</td></tr>';

    opRows.innerHTML = oLogs.length ? oLogs.map((r) =>
      '<tr><td>' + esc(r.user_email || '-') + '</td><td>' + esc(r.created_at) + '</td><td><span class=\"tag ' + esc(r.action_type) + '\">' + esc(r.action_type) + '</span></td><td>' + esc(r.target_type) + '</td><td>' + esc(r.target_id ?? '-') + '</td><td class=\"muted\">' + esc(r.detail || '-') + '</td></tr>'
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
  try {
    return new TextDecoder('shift_jis', { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
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
}): input is {
  title: string;
  note: string;
  amount: number;
  type: 'income' | 'expense';
  scheduledDate: string;
  accountName: string;
  customerName: string;
  staffName: string;
  labelColor: string;
} {
  const allowedAccounts = new Set(['', '三井住友口座', '和気口座', '那須口座']);
  const allowedColors = new Set<string>(ENTRY_LABEL_COLORS);
  return (
    input.title.length > 0 &&
    input.title.length <= MAX_TITLE_LENGTH &&
    input.note.length <= MAX_NOTE_LENGTH &&
    allowedAccounts.has(input.accountName) &&
    input.accountName.length <= 80 &&
    input.customerName.length <= 80 &&
    input.staffName.length <= 80 &&
    allowedColors.has(input.labelColor) &&
    Number.isInteger(input.amount) &&
    Number(input.amount) >= MIN_AMOUNT &&
    Number(input.amount) <= MAX_AMOUNT &&
    isValidType(input.type) &&
    isValidDate(typeof input.scheduledDate === 'string' ? input.scheduledDate : undefined)
  );
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

export default app;
