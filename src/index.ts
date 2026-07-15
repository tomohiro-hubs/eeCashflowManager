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
type AppErrorLogRow = {
  id: number;
  request_id: string | null;
  user_id: number | null;
  organization_id: number | null;
  user_email: string | null;
  organization_name: string | null;
  source: string;
  level: 'error' | 'warn';
  method: string | null;
  path: string | null;
  status_code: number | null;
  message: string;
  error_name: string | null;
  stack: string | null;
  detail: string | null;
  created_at: string;
};
type AppErrorLogInsert = {
  requestId?: string | null;
  userId?: number | null;
  organizationId?: number | null;
  source: string;
  level?: 'error' | 'warn';
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  message: string;
  errorName?: string | null;
  stack?: string | null;
  detail?: unknown;
};
type CashflowImportParsedRow = {
  rowNumber: number;
  id: string;
  scheduledDate: string;
  type: 'income' | 'expense';
  title: string;
  content: string;
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
};
type CashflowImportPreviewNewEntry = {
  rowNumber: number;
  title: string;
  content: string;
  amount: number;
  type: 'income' | 'expense';
  scheduledDate: string;
  note: string;
  actualDate: string;
  customerName: string;
  staffName: string;
  labelColor: string;
  cfCategory: string;
  isCompleted: number;
  managementNo: string;
};
type CashflowImportPreviewUpdateEntry = CashflowImportPreviewNewEntry & {
  id: number;
  titleOld: string;
  contentOld: string;
  amountOld: number;
  typeOld: 'income' | 'expense';
  scheduledDateOld: string;
  noteOld: string;
  actualDateOld: string | null;
  customerNameOld: string | null;
  staffNameOld: string | null;
  labelColorOld: string;
  cfCategoryOld: string;
  isCompletedOld: number;
  managementNoOld: string | null;
  hasDiff: boolean;
};

const CASHFLOW_BACKUP_RETENTION_DAYS = 7;

const app = new Hono<{ Bindings: Env; Variables: { user: User | null } }>();
const SESSION_COOKIE = 'cf_cashflow_session';
const SESSION_TTL_DAYS = 14;
const SESSION_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MINUTES = 30;
const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_LENGTH = 140;
const MAX_NOTE_LENGTH = 500;
const MAX_AMOUNT = 10_000_000_000;
const PASSWORD_RESET_TTL_MINUTES = 30;
const PASSWORD_ALGO_PBKDF2 = 'pbkdf2_sha256_310000';
const PASSWORD_ALGO_LEGACY = 'sha256_iter120k';
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const REGISTRATION_ENABLED = false;
const ENTRY_LABEL_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'brown', 'pink', 'gray', 'lightblue'] as const;
const ENTRY_LABEL_COLOR_LABELS: Record<(typeof ENTRY_LABEL_COLORS)[number], string> = {
  red: '赤',
  orange: '橙',
  yellow: '黄',
  green: '緑',
  blue: '青',
  purple: '紫',
  brown: '茶',
  pink: '桃',
  gray: '灰',
  lightblue: '水'
};
const CF_CATEGORIES = [
  '',
  '現金売上',
  '売掛金回収',
  '未収入金・前受金入金',
  'その他の収入',
  '売電収入（西予発電所）',
  '売電収入（府中発電所）',
  '売電収入（茨城発電所）',
  'その他の収入（社長）',
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
  '保険料',
  '業務委託費',
  '固定性預金払戻し',
  '銀行借入',
  'E借入',
  'E借入（事業分）',
  'E借入（非事業分）',
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
  'その他の収入（社長）',
  '固定性預金払戻し',
  '銀行借入',
  'E借入',
  'E借入（事業分）',
  'E借入（非事業分）',
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
  '保険料',
  '業務委託費',
  '銀行借入返済',
  'E借入（事業分）',
  'E借入（非事業分）',
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
  '売電収入（茨城発電所）',
  'その他の収入（社長）'
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
  'その他の支出（その他）',
  '保険料',
  '業務委託費'
]);
const CASHFLOW_STATEMENT_FINANCING_INCOME_CATEGORIES = new Set([
  '固定性預金払戻し',
  '銀行借入',
  'E借入',
  'E借入（事業分）',
  'E借入（非事業分）',
  '売電事業分資金移動',
  '設備収入（設備売却など）',
  'その他の財務等収入'
]);
const CASHFLOW_STATEMENT_FINANCING_EXPENSE_CATEGORIES = new Set([
  '銀行借入返済',
  'E借入',
  'E借入（事業分）',
  'E借入（非事業分）',
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

function getSessionCookieOptions(c: Context, expires: Date) {
  const url = new URL(c.req.url);
  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  return {
    httpOnly: true,
    secure: !isLocalhost,
    sameSite: 'Strict' as const,
    path: '/',
    expires
  };
}

async function resolveUserOrganizationId(db: D1Database, userId: number, preferredOrganizationId: number | null): Promise<number | null> {
  if (Number.isInteger(preferredOrganizationId) && Number(preferredOrganizationId) > 0) {
    return Number(preferredOrganizationId);
  }

  const memberRow = await db.prepare(
    `SELECT organization_id
     FROM organization_members
     WHERE user_id = ?
     ORDER BY CASE role
       WHEN 'owner' THEN 0
       WHEN 'admin' THEN 1
       WHEN 'editor' THEN 2
       WHEN 'member' THEN 3
       WHEN 'viewer' THEN 4
       ELSE 5
     END, organization_id ASC
     LIMIT 1`
  )
    .bind(userId)
    .first<{ organization_id: number }>();

  const organizationId = Number(memberRow?.organization_id ?? 0);
  if (Number.isInteger(organizationId) && organizationId > 0) {
    await db.prepare('UPDATE users SET organization_id = ? WHERE id = ? AND organization_id IS NULL')
      .bind(organizationId, userId)
      .run();
    return organizationId;
  }

  return null;
}

class CsvImportParseError extends Error {
  code: CsvImportErrorCode;
  constructor(code: CsvImportErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

async function recordAppError(db: D1Database, entry: AppErrorLogInsert): Promise<void> {
  try {
    const detailText = entry.detail === undefined
      ? null
      : typeof entry.detail === 'string'
        ? entry.detail
        : JSON.stringify(entry.detail);
    await db.prepare(
      `INSERT INTO app_error_logs
        (request_id, user_id, organization_id, source, level, method, path, status_code, message, error_name, stack, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      entry.requestId ?? null,
      entry.userId ?? null,
      entry.organizationId ?? null,
      entry.source,
      entry.level ?? 'error',
      entry.method ?? null,
      entry.path ?? null,
      entry.statusCode ?? null,
      entry.message,
      entry.errorName ?? null,
      entry.stack ?? null,
      detailText
    ).run();
  } catch (logError) {
    console.error('failed to persist app error log', logError);
  }
}

function serializeError(error: unknown): { message: string; name: string | null; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message || error.name || 'Error', name: error.name || 'Error', stack: error.stack ?? null };
  }
  return { message: String(error ?? 'Unknown error'), name: null, stack: null };
}

app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  const pathname = new URL(c.req.url).pathname;
  const framePolicy = pathname === '/cashflow-statement' ? 'SAMEORIGIN' : 'DENY';
  const cspFrameAncestors = pathname === '/cashflow-statement' ? "'self'" : "'none'";
  c.header('X-Frame-Options', framePolicy);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  c.header('Content-Security-Policy', `default-src 'self'; base-uri 'self'; frame-ancestors ${cspFrameAncestors}; form-action 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'`);
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

  if (row) {
    const organizationId = await resolveUserOrganizationId(c.env.DB, row.id, row.organization_id);
    c.set('user', { id: row.id, email: row.email, isAdmin: Number(row.is_admin) === 1, organizationId });
  } else {
    c.set('user', null);
  }

  // Sliding expiration: extend only when session is close enough to expiry.
  if (row) {
    const nowMs = Date.now();
    const expiresMs = Date.parse(row.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs - nowMs <= SESSION_REFRESH_WINDOW_MS) {
      const nextExpires = new Date(nowMs + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').bind(nextExpires, token).run();
      setCookie(c, SESSION_COOKIE, token, getSessionCookieOptions(c, new Date(nextExpires)));
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
app.get('/register', (c) => {
  if (!REGISTRATION_ENABLED) return c.html(renderAuthPage('login', '新規アカウント作成は停止しています。管理者から案内されたアカウントでログインしてください。'), 403);
  return c.html(renderAuthPage('register'));
});

app.post('/register', async (c) => {
  if (!REGISTRATION_ENABLED) {
    return c.html(renderAuthPage('login', '新規アカウント作成は現在停止しています。'), 403);
  }

  const form = await c.req.parseBody();
  const email = normalizeEmail(String(form.email ?? ''));
  const password = String(form.password ?? '');
  const passwordConfirm = String(form.passwordConfirm ?? '');

  if (!email || !password || !passwordConfirm) {
    return c.html(renderAuthPage('register', 'すべての項目を入力してください。'), 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.html(renderAuthPage('register', 'メールアドレスの形式が正しくありません。'), 400);
  }
  if (password !== passwordConfirm) {
    return c.html(renderAuthPage('register', 'パスワードが一致しません。'), 400);
  }
  if (!isStrongPassword(password)) {
    return c.html(renderAuthPage('register', 'パスワードは10文字以上で、大文字・小文字・数字・記号を含めてください。'), 400);
  }

  const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number }>();
  if (existingUser) {
    return c.html(renderAuthPage('register', 'このメールアドレスは既に登録されています。'), 409);
  }

  const salt = randomToken(16);
  const passwordHash = await hashPasswordPbkdf2(password, salt);

  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO organizations (id, name, created_at)
     VALUES (1, 'Default Organization', datetime('now'))`
  ).run();
  await c.env.DB.prepare(
    `INSERT INTO users (email, password_hash, password_salt, password_algo, organization_id, created_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'))`
  ).bind(email, passwordHash, salt, PASSWORD_ALGO_PBKDF2).run();

  const createdUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number }>();
  if (createdUser) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, created_at)
       VALUES (1, ?, 'member', datetime('now'))`
    ).bind(createdUser.id).run();
  }

  return c.html(renderAuthPage('login', 'アカウントを作成しました。メールアドレスとパスワードでログインしてください。'));
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

  const organizationId = await resolveUserOrganizationId(c.env.DB, user.id, null);
  if (!organizationId) {
    await recordLoginFailure(c.env.DB, loginRateLimitKey);
    return c.html(renderAuthPage('login', 'このアカウントには利用可能な所属組織がありません。管理者に確認してください。'), 403);
  }

  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await c.env.DB.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)')
    .bind(user.id, token, expires)
    .run();
  await c.env.DB.prepare(
    'INSERT INTO user_session_logs (user_id, session_token, login_at) VALUES (?, ?, datetime(\'now\'))'
  ).bind(user.id, token).run();

  setCookie(c, SESSION_COOKIE, token, getSessionCookieOptions(c, new Date(expires)));

  return c.redirect('/app');
});

app.onError((err, c) => {
  const requestId = crypto.randomUUID();
  const user = c.get('user');
  const serialized = serializeError(err);
  void recordAppError(c.env.DB, {
    requestId,
    userId: user?.id ?? null,
    organizationId: user?.organizationId ?? null,
    source: 'onError',
    method: c.req.method,
    path: c.req.path,
    statusCode: 500,
    message: serialized.message,
    errorName: serialized.name,
    stack: serialized.stack,
    detail: { requestId }
  });
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
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  return c.html(renderAppPage(user.email, user.isAdmin, auth.organizationId));
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
  const embedded = String(c.req.query('embedded') ?? '') === '1';
  const cashflowStatementData = await loadCashflowStatementData(c.env.DB, auth.organizationId, 2026, 2031);
  return c.html(renderCashflowStatementPage(user.email, user.isAdmin, cashflowStatementData, { embedded }));
});

app.get('/audit', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login');
  if (!user.isAdmin) return c.text('Forbidden', 403);
  return c.html(renderAuditPage(user.email));
});

app.get('/admin/error-logs', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  if (!user.isAdmin) return c.text('Forbidden', 403);

  const from = parseDateOnly(c.req.query('from'));
  const to = parseDateOnly(c.req.query('to'));
  const source = String(c.req.query('source') ?? '').trim();
  const search = String(c.req.query('search') ?? '').trim();
  if ((c.req.query('from') && !from) || (c.req.query('to') && !to)) {
    return c.text('Invalid date. Use YYYY-MM-DD.', 400);
  }

  const errorLogs = await listAppErrorLogs(c.env.DB, organizationId, {
    from,
    to,
    source,
    search
  });
  return c.html(renderErrorLogsPage(user.email, errorLogs, { from, to, source, search }));
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
    const serialized = serializeError(error);
    await recordAppError(c.env.DB, {
      userId: user.id,
      organizationId,
      source: 'backup-create',
      method: c.req.method,
      path: c.req.path,
      statusCode: 500,
      message: serialized.message,
      errorName: serialized.name,
      stack: serialized.stack,
      detail: { organizationId }
    });
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
    const serialized = serializeError(error);
    await recordAppError(c.env.DB, {
      userId: user.id,
      organizationId,
      source: 'backup-restore',
      method: c.req.method,
      path: c.req.path,
      statusCode: 500,
      message: serialized.message,
      errorName: serialized.name,
      stack: serialized.stack,
      detail: { backupId, organizationId }
    });
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
  const { startDate, endDate } = getYearDateRange(year);
  const month = c.req.query('month');
  const parsedMonth = month === 'all' || month === '' || month == null ? 'all' : parseMonth(month);
  if (parsedMonth == null) return c.json({ error: 'Invalid month. Use YYYY-MM.' }, 400);
  if (parsedMonth !== 'all' && !parsedMonth.startsWith(`${year}-`)) {
    return c.json({ error: 'Month must be within the selected year.' }, 400);
  }
  const monthRange = parsedMonth === 'all' ? null : getMonthDateRange(parsedMonth);
  const listStartDate = monthRange?.startDate ?? startDate;
  const listEndDate = monthRange?.endDate ?? endDate;

  const carryRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) as carry_balance
     FROM cashflow_entries
     WHERE organization_id = ?
       AND deleted_at IS NULL
       AND is_completed = 1
       AND scheduled_date >= ?
       AND scheduled_date < ?`
  )
    .bind(organizationId, startDate, listStartDate)
    .first<{ carry_balance: number }>();

  const result = await c.env.DB.prepare(
    `SELECT id, scheduled_date, title, content, amount, note, type, customer_name
     FROM cashflow_entries
     WHERE organization_id = ?
       AND deleted_at IS NULL
       AND is_completed = 1
       AND scheduled_date >= ?
       AND scheduled_date < ?
     ORDER BY scheduled_date ASC, order_index ASC, id ASC`
  )
    .bind(organizationId, listStartDate, listEndDate)
    .all<{ id: number; scheduled_date: string; title: string; content: string | null; amount: number; note: string | null; type: 'income' | 'expense'; customer_name: string | null }>();

  return c.json({ year, month: parsedMonth, carryBalance: Number(carryRow?.carry_balance ?? 0), entries: result.results ?? [] });
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
  const { startDate, endDate } = getYearDateRange(year);

  const result = await c.env.DB.prepare(
    `SELECT id, title, content, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, cf_category, is_sample, is_completed, created_by_user_id, import_management_no
     FROM cashflow_entries
     WHERE organization_id = ?
       AND scheduled_date >= ?
       AND scheduled_date < ?
       AND deleted_at IS NULL
     ORDER BY scheduled_date ASC, order_index ASC, id ASC`
  )
    .bind(organizationId, startDate, endDate)
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
     WHERE organization_id = ? AND deleted_at IS NULL AND is_completed = 1 AND scheduled_date < ?`
  )
    .bind(organizationId, `${month}-01`)
    .first<{ opening_balance: number }>();

  return c.json({ month, openingBalance: Number(row?.opening_balance ?? 0) });
});

app.get('/api/today-balance', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { organizationId } = auth;

  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStr = jstNow.toISOString().slice(0, 10);

  const row = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) as balance
     FROM cashflow_entries
     WHERE organization_id = ? AND deleted_at IS NULL AND is_completed = 1 AND scheduled_date <= ?`
  )
    .bind(organizationId, todayStr)
    .first<{ balance: number }>();

  return c.json({ todayBalance: Number(row?.balance ?? 0) });
});

// 主画面(/app)の初期表示に必要な4種のデータを1リクエストにまとめて返す。
// 認証や往復回数を減らすための集約エンドポイント。数字の計算ロジックは
// 既存の /api/summary, /api/entries, /api/opening-balance, /api/today-balance と同一。
// 一部のクエリが失敗しても画面全体が落ちないよう、成功した分は返しつつ、
// 失敗した項目だけ errors に日本語メッセージを載せる。
app.get('/api/app-bootstrap', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { organizationId } = auth;

  const year = parseYear(c.req.query('year'));
  if (!year) return c.json({ error: '年の指定が正しくありません。YYYY（例: 2026）形式で指定してください。' }, 400);
  const month = parseMonth(c.req.query('month'));
  if (!month) return c.json({ error: '月の指定が正しくありません。YYYY-MM（例: 2026-07）形式で指定してください。' }, 400);
  if (!month.startsWith(`${year}-`)) {
    return c.json({ error: '選択中の年と月が一致していません。' }, 400);
  }

  try {
    const { startDate, endDate } = getYearDateRange(year);
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const todayStr = jstNow.toISOString().slice(0, 10);

    // 4クエリを同時に投げる。allSettled なので1つ失敗しても全体は止まらない。
    const [summaryR, entriesR, openingR, todayR] = await Promise.allSettled([
      c.env.DB.prepare(
        `SELECT
         COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
          COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
         FROM cashflow_entries
         WHERE organization_id = ? AND substr(scheduled_date, 1, 7) = ? AND deleted_at IS NULL`
      )
        .bind(organizationId, month)
        .first<{ income: number; expense: number }>(),
      c.env.DB.prepare(
        `SELECT id, title, content, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, cf_category, is_sample, is_completed, created_by_user_id, import_management_no
         FROM cashflow_entries
         WHERE organization_id = ?
           AND scheduled_date >= ?
           AND scheduled_date < ?
           AND deleted_at IS NULL
         ORDER BY scheduled_date ASC, order_index ASC, id ASC`
      )
        .bind(organizationId, startDate, endDate)
        .all(),
      // 期首残高は「選択年の1月1日より前」の完了分累計。
      // 既存クライアントが常に year-01 を渡していた挙動に合わせる（選択月ではなく年初が基準）。
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) as opening_balance
         FROM cashflow_entries
         WHERE organization_id = ? AND deleted_at IS NULL AND is_completed = 1 AND scheduled_date < ?`
      )
        .bind(organizationId, `${year}-01-01`)
        .first<{ opening_balance: number }>(),
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) as balance
         FROM cashflow_entries
         WHERE organization_id = ? AND deleted_at IS NULL AND is_completed = 1 AND scheduled_date <= ?`
      )
        .bind(organizationId, todayStr)
        .first<{ balance: number }>()
    ]);

    const errors: Record<string, string> = {};

    let summary = { income: 0, expense: 0, balance: 0 };
    if (summaryR.status === 'fulfilled') {
      const income = Number(summaryR.value?.income ?? 0);
      const expense = Number(summaryR.value?.expense ?? 0);
      summary = { income, expense, balance: income - expense };
    } else {
      errors.summary = '月次サマリー（入金・出金・差引）の取得に失敗しました。';
      console.error('app-bootstrap summary failed', summaryR.reason);
    }

    let entries: unknown[] = [];
    if (entriesR.status === 'fulfilled') {
      entries = entriesR.value.results ?? [];
    } else {
      errors.entries = '予定一覧の取得に失敗しました。';
      console.error('app-bootstrap entries failed', entriesR.reason);
    }

    let openingBalance = 0;
    if (openingR.status === 'fulfilled') {
      openingBalance = Number(openingR.value?.opening_balance ?? 0);
    } else {
      errors.openingBalance = '期首残高の計算に失敗しました。';
      console.error('app-bootstrap opening-balance failed', openingR.reason);
    }

    let todayBalance = 0;
    if (todayR.status === 'fulfilled') {
      todayBalance = Number(todayR.value?.balance ?? 0);
    } else {
      errors.todayBalance = '本日時点残高の計算に失敗しました。';
      console.error('app-bootstrap today-balance failed', todayR.reason);
    }

    return c.json({ year, month, summary, entries, openingBalance, todayBalance, errors });
  } catch (err) {
    console.error('app-bootstrap unexpected error', err);
    return c.json({ error: '画面データの取得中に予期しないエラーが発生しました。時間をおいて再読み込みしてください。' }, 500);
  }
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
    content?: string;
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
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const accountName = typeof body.accountName === 'string' ? body.accountName.trim() : '';
  const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : '';
  const staffName = typeof body.staffName === 'string' ? body.staffName.trim() : '';
  const labelColor = typeof body.labelColor === 'string' ? body.labelColor.trim() : '';
  const cfCategory = typeof body.cfCategory === 'string' ? body.cfCategory.trim() : '';
  const amountState = parseNormalizedAmount(body.amount);
  const allowedCfCategories = new Set(['', ...getCfCategoriesByEntryType(typeof body.type === 'string' ? body.type : 'income')]);

  if (amountState.amount == null) {
    return c.json({ error: '金額は1円以上の整数で入力してください。', field: 'amount' }, 400);
  }

  const validatedInput = {
    title,
    content,
    note,
    amount: amountState.amount,
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

  const insertResult = await c.env.DB.prepare(
    `INSERT INTO cashflow_entries
      (user_id, organization_id, title, content, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, cf_category, is_sample, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(
      user.id,
      organizationId,
      validatedInput.title,
      validatedInput.content || null,
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
  const newEntryId = Number(insertResult?.meta?.last_row_id ?? 0);
  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
     VALUES (?, 'add', 'cashflow_entry', ?)`
  ).bind(user.id, JSON.stringify({
    title: validatedInput.title,
    content: validatedInput.content,
    amount: validatedInput.amount,
    type: validatedInput.type,
    scheduledDate: validatedInput.scheduledDate
  })).run();

  return c.json({ ok: true, entry: { id: newEntryId, orderIndex: order } });
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
      const serialized = serializeError(error);
      await recordAppError(c.env.DB, {
        userId: user.id,
        organizationId,
        source: 'csv-import-preview',
        method: c.req.method,
        path: c.req.path,
        statusCode: 400,
        message: serialized.message,
        errorName: serialized.name,
        stack: serialized.stack,
        detail: { phase: 'multipart-parse' }
      });
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
      const serialized = serializeError(error);
      await recordAppError(c.env.DB, {
        userId: user.id,
        organizationId,
        source: 'csv-import-preview',
        method: c.req.method,
        path: c.req.path,
        statusCode: error instanceof CsvImportParseError ? 400 : 500,
        message: serialized.message,
        errorName: serialized.name,
        stack: serialized.stack,
        detail: { phase: 'csv-parse' }
      });
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
    const serialized = serializeError(error);
    await recordAppError(c.env.DB, {
      userId: user.id,
      organizationId,
      source: 'csv-import-preview',
      method: c.req.method,
      path: c.req.path,
      statusCode: 500,
      message: serialized.message,
      errorName: serialized.name,
      stack: serialized.stack
    });
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
    const serialized = serializeError(error);
    await recordAppError(c.env.DB, {
      userId: user.id,
      organizationId,
      source: 'csv-import-commit',
      method: c.req.method,
      path: c.req.path,
      statusCode: 500,
      message: serialized.message,
      errorName: serialized.name,
      stack: serialized.stack
    });
    console.error('rakuraku import commit failed', { userId: user.id, error });
    return c.json({ ok: false, error: 'インポート確定処理中にエラーが発生しました。' }, 500);
  }
});

app.post('/api/import/cashflow/preview', async (c) => {
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
      const serialized = serializeError(error);
      await recordAppError(c.env.DB, {
        userId: user.id,
        organizationId,
        source: 'cashflow-import-preview',
        method: c.req.method,
        path: c.req.path,
        statusCode: 400,
        message: serialized.message,
        errorName: serialized.name,
        stack: serialized.stack,
        detail: { phase: 'multipart-parse' }
      });
      console.error('cashflow import preview multipart parse failed', { userId: user.id, error });
      return c.json({ ok: false, errorCode: CSV_IMPORT_ERROR_CODES.multipartParseFailed, error: 'multipart/form-data の解析に失敗しました。' }, 400);
    }

    const file = form.file;
    if (!(file instanceof File)) {
      return c.json({ ok: false, errorCode: CSV_IMPORT_ERROR_CODES.fileMissing, error: 'CSVファイルがありません。' }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = decodeShiftJisLike(bytes);

    let parsedRows: CashflowImportParsedRow[] = [];
    try {
      parsedRows = parseCashflowImportCsvText(text);
    } catch (error) {
      const serialized = serializeError(error);
      await recordAppError(c.env.DB, {
        userId: user.id,
        organizationId,
        source: 'cashflow-import-preview',
        method: c.req.method,
        path: c.req.path,
        statusCode: error instanceof CsvImportParseError ? 400 : 500,
        message: serialized.message,
        errorName: serialized.name,
        stack: serialized.stack,
        detail: { phase: 'csv-parse' }
      });
      console.error('cashflow import preview csv parse failed', { userId: user.id, error });
      if (error instanceof CsvImportParseError) {
        return c.json({ ok: false, errorCode: error.code, error: error.message }, 400);
      }
      return c.json({ ok: false, errorCode: CSV_IMPORT_ERROR_CODES.internalError, error: 'CSVファイルの解析に失敗しました。' }, 500);
    }

    if (parsedRows.length === 0) {
      return c.json({ ok: true, totalRows: 0, invalidRows: 0, newEntries: [], updateEntries: [], rowErrors: [], message: '取り込み可能な行がありませんでした。' });
    }

    const monthSet = new Set(parsedRows.map((row) => row.scheduledDate.slice(0, 7)));
    const existingById = new Map<number, {
      id: number;
      title: string;
      content: string | null;
      amount: number;
      type: 'income' | 'expense';
      scheduled_date: string;
      note: string | null;
      actual_transaction_date: string | null;
      customer_name: string | null;
      staff_name: string | null;
      label_color: string | null;
      cf_category: string | null;
      is_completed: number;
      import_management_no: string | null;
    }>();
    const existingByKey = new Map<string, {
      id: number;
      title: string;
      content: string | null;
      amount: number;
      type: 'income' | 'expense';
      scheduled_date: string;
      note: string | null;
      actual_transaction_date: string | null;
      customer_name: string | null;
      staff_name: string | null;
      label_color: string | null;
      cf_category: string | null;
      is_completed: number;
      import_management_no: string | null;
    }>();
    const monthList = [...monthSet];
    if (monthList.length > 0) {
      const monthChunkSize = 80;
      for (let i = 0; i < monthList.length; i += monthChunkSize) {
        const chunk = monthList.slice(i, i + monthChunkSize);
        const monthPlaceholders = chunk.map(() => '?').join(', ');
        const rows = await c.env.DB.prepare(
          `SELECT id, title, content, amount, type, scheduled_date, note, actual_transaction_date, customer_name, staff_name, label_color, cf_category, is_completed, import_management_no
           FROM cashflow_entries
           WHERE organization_id = ? AND deleted_at IS NULL AND substr(scheduled_date, 1, 7) IN (${monthPlaceholders})`
        ).bind(organizationId, ...chunk).all<{
          id: number;
          title: string;
          content: string | null;
          amount: number;
          type: 'income' | 'expense';
          scheduled_date: string;
          note: string | null;
          actual_transaction_date: string | null;
          customer_name: string | null;
          staff_name: string | null;
          label_color: string | null;
          cf_category: string | null;
          is_completed: number;
          import_management_no: string | null;
        }>();
        for (const row of rows.results ?? []) {
          const existing = {
            id: Number(row.id),
            title: row.title || '',
            content: row.content || '',
            amount: Number(row.amount || 0),
            type: row.type,
            scheduled_date: row.scheduled_date || '',
            note: row.note || '',
            actual_transaction_date: row.actual_transaction_date || '',
            customer_name: row.customer_name || '',
            staff_name: row.staff_name || '',
            label_color: row.label_color || '',
            cf_category: row.cf_category || '',
            is_completed: Number(row.is_completed ?? 0),
            import_management_no: row.import_management_no || ''
          };
          existingById.set(existing.id, existing);
          existingByKey.set(buildCashflowImportMatchKey({
            scheduledDate: existing.scheduled_date,
            type: existing.type,
            title: existing.title,
            content: existing.content || '',
            amount: existing.amount,
            note: existing.note || '',
            actualDate: existing.actual_transaction_date || '',
            customerName: existing.customer_name || '',
            staffName: existing.staff_name || '',
            labelColor: existing.label_color || '',
            cfCategory: existing.cf_category || '',
            isCompleted: existing.is_completed,
            managementNo: existing.import_management_no || ''
          }), existing);
        }
      }
    }

    const newEntries: CashflowImportPreviewNewEntry[] = [];
    const updateEntries: CashflowImportPreviewUpdateEntry[] = [];
    const rowErrors: Array<{ rowNumber: number; message: string }> = [];

    for (const row of parsedRows) {
      const idValue = row.id ? Number(row.id) : null;
      const existingByIdRow = idValue !== null && Number.isInteger(idValue) && idValue > 0 ? existingById.get(idValue) : undefined;
      if (row.id && (!Number.isInteger(idValue as number) || (idValue as number) <= 0)) {
        rowErrors.push({ rowNumber: row.rowNumber, message: 'IDが正しくありません。' });
        continue;
      }
      if (row.id && !existingByIdRow) {
        rowErrors.push({ rowNumber: row.rowNumber, message: `指定されたID（${row.id}）が存在しないか、更新権限がありません。` });
        continue;
      }

      const existing = existingByIdRow || existingByKey.get(buildCashflowImportMatchKey({
        scheduledDate: row.scheduledDate,
        type: row.type,
        title: row.title,
        content: row.content,
        amount: row.amount,
        note: row.note || '',
        actualDate: row.actualDate || '',
        customerName: row.customerName || '',
        staffName: row.staffName || '',
        labelColor: row.labelColor || '',
        cfCategory: row.cfCategory || '',
        isCompleted: row.isCompleted,
        managementNo: row.managementNo || ''
      }));

      if (existing) {
        const hasDiff = buildCashflowImportMatchKey({
          scheduledDate: row.scheduledDate,
          type: row.type,
          title: row.title,
          content: row.content,
          amount: row.amount,
          note: row.note || '',
          actualDate: row.actualDate || '',
          customerName: row.customerName || '',
          staffName: row.staffName || '',
          labelColor: row.labelColor || '',
          cfCategory: row.cfCategory || '',
          isCompleted: row.isCompleted,
          managementNo: row.managementNo || ''
        }) !== buildCashflowImportMatchKey({
          scheduledDate: existing.scheduled_date,
          type: existing.type,
          title: existing.title,
          content: existing.content || '',
          amount: existing.amount,
          note: existing.note || '',
          actualDate: existing.actual_transaction_date || '',
          customerName: existing.customer_name || '',
          staffName: existing.staff_name || '',
          labelColor: existing.label_color || '',
          cfCategory: existing.cf_category || '',
          isCompleted: Number(existing.is_completed ?? 0),
          managementNo: existing.import_management_no || ''
        });

        updateEntries.push({
          rowNumber: row.rowNumber,
          id: existing.id,
          title: row.title,
          content: row.content,
          amount: row.amount,
          type: row.type,
          scheduledDate: row.scheduledDate,
          note: row.note,
          actualDate: row.actualDate,
          customerName: row.customerName,
          staffName: row.staffName,
          labelColor: row.labelColor,
          cfCategory: row.cfCategory,
          isCompleted: row.isCompleted,
          managementNo: row.managementNo,
          titleOld: existing.title,
          contentOld: existing.content || '',
          amountOld: existing.amount,
          typeOld: existing.type,
          scheduledDateOld: existing.scheduled_date,
          noteOld: existing.note || '',
          actualDateOld: existing.actual_transaction_date,
          customerNameOld: existing.customer_name,
          staffNameOld: existing.staff_name,
          labelColorOld: existing.label_color || '',
          cfCategoryOld: existing.cf_category || '',
          isCompletedOld: Number(existing.is_completed ?? 0),
          managementNoOld: existing.import_management_no,
          hasDiff
        });
      } else {
        newEntries.push({
          rowNumber: row.rowNumber,
          title: row.title,
          content: row.content,
          amount: row.amount,
          type: row.type,
          scheduledDate: row.scheduledDate,
          note: row.note,
          actualDate: row.actualDate,
          customerName: row.customerName,
          staffName: row.staffName,
          labelColor: row.labelColor,
          cfCategory: row.cfCategory,
          isCompleted: row.isCompleted,
          managementNo: row.managementNo
        });
      }
    }

    return c.json({
      ok: true,
      totalRows: parsedRows.length,
      invalidRows: rowErrors.length,
      newEntries,
      updateEntries,
      rowErrors,
      message: 'CSVの確認が完了しました。'
    });
  } catch (error) {
    const serialized = serializeError(error);
    await recordAppError(c.env.DB, {
      userId: user.id,
      organizationId,
      source: 'cashflow-import-preview',
      method: c.req.method,
      path: c.req.path,
      statusCode: 500,
      message: serialized.message,
      errorName: serialized.name,
      stack: serialized.stack
    });
    console.error('cashflow import preview failed', { userId: user.id, error });
    return c.json({ ok: false, error: 'CSV取り込み確認中にエラーが発生しました。' }, 500);
  }
});

app.post('/api/import/cashflow/commit', async (c) => {
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
      newEntries?: Array<CashflowImportPreviewNewEntry>;
      updateEntries?: Array<CashflowImportPreviewUpdateEntry>;
    }>(c);
    if (!body) {
      return c.json({ ok: false, error: 'リクエストボディがありません。' }, 400);
    }

    const newEntries = Array.isArray(body.newEntries) ? body.newEntries : [];
    const updateEntries = Array.isArray(body.updateEntries) ? body.updateEntries : [];
    if (newEntries.length === 0 && updateEntries.length === 0) {
      return c.json({ ok: true, insertedCount: 0, updatedCount: 0, message: '適用するデータがありません。' });
    }

    const monthSet = new Set<string>();
    for (const row of newEntries) monthSet.add(String(row.scheduledDate || '').slice(0, 7));
    for (const row of updateEntries) monthSet.add(String(row.scheduledDate || '').slice(0, 7));
    const monthList = [...monthSet].filter((v) => v !== '');
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
    let updatedCount = 0;
    for (const row of updateEntries) {
      const id = Number(row.id);
      if (!Number.isInteger(id) || id <= 0) {
        continue;
      }
      statements.push(
        c.env.DB.prepare(
          `UPDATE cashflow_entries
           SET title = ?, content = ?, amount = ?, type = ?, scheduled_date = ?, note = ?, actual_transaction_date = ?,
               customer_name = ?, staff_name = ?, label_color = ?, cf_category = ?,
               is_completed = ?, import_management_no = ?, updated_at = datetime('now')
           WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
        ).bind(
          row.title,
          row.content || null,
          row.amount,
          row.type,
          row.scheduledDate,
          row.note || null,
          row.actualDate || null,
          row.customerName || null,
          row.staffName || null,
          row.labelColor || '',
          row.cfCategory || '',
          row.isCompleted,
          row.managementNo || null,
          id,
          organizationId
        )
      );
      updatedCount += 1;
    }

    let insertedCount = 0;
    for (const row of newEntries) {
      const month = String(row.scheduledDate || '').slice(0, 7);
      let nextOrder = Number(orderMap.get(month) ?? 0);
      nextOrder += 1;
      orderMap.set(month, nextOrder);

      statements.push(
        c.env.DB.prepare(
          `INSERT INTO cashflow_entries
            (user_id, organization_id, title, content, amount, type, scheduled_date, order_index, note, account_name,
             actual_transaction_date, customer_name, staff_name, label_color, cf_category, is_sample, is_completed, created_by_user_id, import_management_no)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
        ).bind(
          user.id,
          organizationId,
          row.title,
          row.content || null,
          row.amount,
          row.type,
          row.scheduledDate,
          nextOrder,
          row.note || null,
          row.actualDate || null,
          row.customerName || null,
          row.staffName || null,
          row.labelColor || '',
          row.cfCategory || '',
          row.isCompleted,
          user.id,
          row.managementNo || null
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
    const serialized = serializeError(error);
    await recordAppError(c.env.DB, {
      userId: user.id,
      organizationId,
      source: 'cashflow-import-commit',
      method: c.req.method,
      path: c.req.path,
      statusCode: 500,
      message: serialized.message,
      errorName: serialized.name,
      stack: serialized.stack
    });
    console.error('cashflow import commit failed', { userId: user.id, error });
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
      const serialized = serializeError(error);
      await recordAppError(c.env.DB, {
        userId: user.id,
        organizationId,
        source: 'cashflow-import',
        method: c.req.method,
        path: c.req.path,
        statusCode: 400,
        message: serialized.message,
        errorName: serialized.name,
        stack: serialized.stack,
        detail: { phase: 'multipart-parse' }
      });
      console.error('cashflow import multipart parse failed', { userId: user.id, error });
      return c.json({ ok: false, error: 'multipart/form-data の解析に失敗しました。' }, 400);
    }
    const file = form.file;
    if (!(file instanceof File)) {
      return c.json({ ok: false, error: 'CSVファイルがありません。' }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = decodeShiftJisLike(bytes);
    const records = parseCsvRecords(text);
    if (records.length === 0) {
      return c.json({ ok: false, error: 'CSVファイルが空です。' }, 400);
    }
    if (records.length === 1) {
      return c.json({ ok: false, error: 'CSVデータ行がありません。' }, 400);
    }

    const header = records[0].map((cell) => cell.replace(/^\uFEFF/, '').trim());
    const idx = {
      id: header.indexOf('ID'),
      scheduledDate: header.indexOf('予定日'),
      type: header.indexOf('区分'),
      cfCategory: header.indexOf('CF区分'),
      title: header.indexOf('件名'),
      content: header.indexOf('内容'),
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
      content: string;
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

    for (let i = 1; i < records.length; i += 1) {
      const cols = records[i] ?? [];
      if (cols.every((cell) => String(cell ?? '').trim() === '')) continue;
      const rawId = idx.id >= 0 ? String(cols[idx.id] ?? '').trim() : '';
      const rawScheduledDate = String(cols[idx.scheduledDate] ?? '').trim();
      const rawType = String(cols[idx.type] ?? '').trim();
      const rawTitle = String(cols[idx.title] ?? '').trim();
      const rawContent = idx.content >= 0 ? String(cols[idx.content] ?? '').trim() : '';
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
        content: rawContent.slice(0, MAX_CONTENT_LENGTH),
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
             SET scheduled_date = ?, type = ?, title = ?, content = ?, amount = ?, note = ?, actual_transaction_date = ?,
                 customer_name = ?, staff_name = ?, is_completed = ?, label_color = ?,
                 cf_category = CASE WHEN ? = 1 THEN ? ELSE cf_category END,
                 import_management_no = ?,
                 updated_at = datetime('now')
             WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
          ).bind(
            row.scheduledDate,
            row.type,
            row.title,
            row.content || null,
            row.amount,
            row.note || null,
            row.actualDate || null,
            row.customerName || null,
            row.staffName || null,
            row.isCompleted,
            row.labelColor || '',
            row.cfCategorySpecified ? 1 : 0,
            row.cfCategorySpecified ? (row.cfCategory || '') : '',
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
              (user_id, organization_id, title, content, amount, type, scheduled_date, order_index, note, account_name,
               actual_transaction_date, customer_name, staff_name, label_color, cf_category, is_sample, is_completed, created_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?)`
          ).bind(
            user.id,
            organizationId,
            row.title,
            row.content || null,
            row.amount,
            row.type,
            row.scheduledDate,
            nextOrder,
            row.note || null,
            row.actualDate || null,
            row.customerName || null,
            row.staffName || null,
            row.labelColor || '',
            row.cfCategory || '',
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
    const serialized = serializeError(error);
    await recordAppError(c.env.DB, {
      userId: user.id,
      organizationId,
      source: 'cashflow-import',
      method: c.req.method,
      path: c.req.path,
      statusCode: 500,
      message: serialized.message,
      errorName: serialized.name,
      stack: serialized.stack
    });
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

app.patch('/api/entries/:id', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

  const body = await parseJsonBody<{
    title?: string;
    content?: string;
    amount?: unknown;
    type?: 'income' | 'expense';
    scheduledDate?: string;
    note?: string;
    accountName?: string;
    customerName?: string;
    staffName?: string;
    labelColor?: string;
    cfCategory?: string;
    importManagementNo?: string;
    actualTransactionDate?: string | null;
    isCompleted?: boolean;
  }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const accountName = typeof body.accountName === 'string' ? body.accountName.trim() : '';
  const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : '';
  const staffName = typeof body.staffName === 'string' ? body.staffName.trim() : '';
  const labelColor = typeof body.labelColor === 'string' ? body.labelColor.trim() : '';
  const cfCategory = typeof body.cfCategory === 'string' ? body.cfCategory.trim() : '';
  const importManagementNo = typeof body.importManagementNo === 'string' ? body.importManagementNo.trim() : '';
  const type = body.type === 'expense' ? 'expense' : body.type === 'income' ? 'income' : '';
  const scheduledDate = parseDateOnly(body.scheduledDate);
  const actualTransactionDateRaw = body.actualTransactionDate == null ? '' : String(body.actualTransactionDate).trim();
  const actualTransactionDate = actualTransactionDateRaw === '' ? null : parseDateOnly(actualTransactionDateRaw);
  const isCompleted = typeof body.isCompleted === 'boolean'
    ? body.isCompleted
    : Number(body.isCompleted) === 1;
  const amount = Number(body.amount);

  if (!actualTransactionDate && actualTransactionDateRaw !== '') {
    return c.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, 400);
  }
  if (!scheduledDate || type === '' || !isValidEntryInput({
    title,
    content,
    note,
    amount,
    type,
    scheduledDate,
    accountName,
    customerName,
    staffName,
    labelColor,
    cfCategory
  }, new Set(['', ...getCfCategoriesByEntryType(type)]))) {
    return c.json({ error: 'Invalid payload' }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT scheduled_date, order_index, title, content, amount, type, is_completed
     FROM cashflow_entries
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(id, organizationId)
    .first<{
      scheduled_date: string;
      order_index: number;
      title: string;
      content: string | null;
      amount: number;
      type: 'income' | 'expense';
      is_completed: number;
    }>();
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

  const result = await c.env.DB.prepare(
    `UPDATE cashflow_entries
     SET title = ?, content = ?, amount = ?, type = ?, scheduled_date = ?, order_index = ?, note = ?, account_name = ?, actual_transaction_date = ?, customer_name = ?, staff_name = ?, label_color = ?, cf_category = ?, import_management_no = ?, is_completed = ?, updated_at = datetime('now')
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  )
    .bind(
      title,
      content || null,
      amount,
      type,
      scheduledDate,
      nextOrder,
      note || null,
      accountName || null,
      actualTransactionDate,
      customerName || null,
      staffName || null,
      labelColor,
      cfCategory,
      importManagementNo || null,
      isCompleted ? 1 : 0,
      id,
      organizationId
    )
    .run();
  if ((result.meta?.changes ?? 0) < 1) return c.json({ error: 'Entry not found' }, 404);

  await c.env.DB.prepare(
    `INSERT INTO user_operation_logs (user_id, action_type, target_type, target_id, detail)
     VALUES (?, 'edit', 'cashflow_entry', ?, ?)`
  ).bind(user.id, id, JSON.stringify({
    scheduledDateFrom: existing.scheduled_date,
    scheduledDateTo: scheduledDate,
    titleFrom: existing.title,
    titleTo: title,
    contentFrom: existing.content || '',
    contentTo: content,
    amountFrom: Number(existing.amount ?? 0),
    amountTo: amount,
    typeFrom: existing.type,
    typeTo: type,
    isCompletedFrom: Number(existing.is_completed) === 1,
    isCompletedTo: isCompleted
  })).run();

  return c.json({
    ok: true,
    entry: {
      id,
      title,
      content: content || null,
      amount,
      type,
      scheduled_date: scheduledDate,
      order_index: nextOrder,
      note: note || null,
      account_name: accountName || null,
      actual_transaction_date: actualTransactionDate,
      customer_name: customerName || null,
      staff_name: staffName || null,
      label_color: labelColor,
      cf_category: cfCategory,
      import_management_no: importManagementNo || null,
      is_completed: isCompleted ? 1 : 0
    }
  });
});

app.post('/api/entries/bulk', async (c) => {
  const auth = requireOrganizationContext(c);
  if (auth instanceof Response) return auth;
  const { user, organizationId } = auth;

  const body = await parseJsonBody<{
    ids?: number[];
    action?: 'set_date' | 'set_actual_date' | 'set_completed' | 'set_cf_category' | 'set_label_color';
    scheduledDate?: string;
    actualTransactionDate?: string | null;
    isCompleted?: boolean;
    cfCategory?: string;
    labelColor?: string;
  }>(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const ids = Array.isArray(body.ids) ? body.ids : [];
  const normalizedIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (normalizedIds.length === 0 || normalizedIds.length > 500) {
    return c.json({ error: 'Invalid ids. Use 1..500 integer ids.' }, 400);
  }
  if (!body.action || !['set_date', 'set_actual_date', 'set_completed', 'set_cf_category', 'set_label_color'].includes(body.action)) {
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

  if (body.action === 'set_cf_category') {
    const entryTypeRows = await c.env.DB.prepare(
      `SELECT DISTINCT type
       FROM cashflow_entries
       WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${normalizedIds.map(() => '?').join(', ')})`
    ).bind(organizationId, ...normalizedIds).all<{ type: 'income' | 'expense' }>();
    const types = [...new Set((entryTypeRows.results ?? []).map((row) => row.type))];
    if (types.length !== 1) {
      return c.json({ error: 'Selected entries must all have the same type.' }, 400);
    }
    const entryType = types[0];
    const cfCategory = typeof body.cfCategory === 'string' ? body.cfCategory.trim() : '';
    const allowedCategories = new Set<string>(['', ...getCfCategoriesByEntryType(entryType)]);
    if (!allowedCategories.has(cfCategory)) {
      return c.json({ error: 'Invalid cf category' }, 400);
    }
    let affected = 0;
    for (let i = 0; i < normalizedIds.length; i += chunkSize) {
      const chunk = normalizedIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await c.env.DB.prepare(
        `UPDATE cashflow_entries
         SET cf_category = ?, updated_at = datetime('now')
         WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`
      ).bind(cfCategory, organizationId, ...chunk).run();
      affected += Number(result.meta.changes ?? 0);
    }
    await c.env.DB.prepare(
      `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
       VALUES (?, 'edit', 'cashflow_entry_bulk_cf_category', ?)`
    ).bind(user.id, JSON.stringify({ ids: normalizedIds, type: entryType, cf_category: cfCategory })).run();
    return c.json({ ok: true, affected, type: entryType, cfCategory });
  }

  if (body.action === 'set_label_color') {
    const labelColor = typeof body.labelColor === 'string' ? body.labelColor.trim() : '';
    const allowedColors = new Set<string>(ENTRY_LABEL_COLORS);
    if (!allowedColors.has(labelColor)) {
      return c.json({ error: 'Invalid color' }, 400);
    }
    let affected = 0;
    for (let i = 0; i < normalizedIds.length; i += chunkSize) {
      const chunk = normalizedIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await c.env.DB.prepare(
        `UPDATE cashflow_entries
         SET label_color = ?, updated_at = datetime('now')
         WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`
      ).bind(labelColor, organizationId, ...chunk).run();
      affected += Number(result.meta.changes ?? 0);
    }
    await c.env.DB.prepare(
      `INSERT INTO user_operation_logs (user_id, action_type, target_type, detail)
       VALUES (?, 'edit', 'cashflow_entry_bulk_label_color', ?)`
    ).bind(user.id, JSON.stringify({ ids: normalizedIds, label_color: labelColor })).run();
    return c.json({ ok: true, affected, labelColor });
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
  const helper = isLogin
    ? 'ログイン情報は管理者から案内されたアカウントをご利用ください。'
    : isRegister
      ? '登録後はこのメールアドレスとパスワードでログインできます。'
      : 'ログイン情報は管理者から案内されたアカウントをご利用ください。';
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
      ${isRegister ? '<label>パスワード（確認）</label><input type="password" name="passwordConfirm" minlength="8" required />' : ''}
      ${isReset ? '<label>新しいパスワード（確認）</label><input type="password" name="passwordConfirm" minlength="8" required />' : ''}
      <button type="submit">${submitLabel}</button>
    </form>
    ${isLogin ? '<p style="color:#5e7188;">新規アカウント作成は停止しています。</p>' : ''}
    <p>${helper}</p>
  </main>
</body>
</html>`;
}

function renderAppPage(email: string, isAdmin: boolean, organizationId: number) {
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
      --list-title-col-width: 220px;
      --list-content-col-width: 180px;
      --list-note-col-width: 140px;
      --annual-title-col-width: 220px;
      --annual-customer-col-width: 160px;
      --annual-note-col-width: 160px;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Noto Sans JP", "Hiragino Sans", sans-serif; background: linear-gradient(180deg, #f7f9fc 0%, var(--bg) 100%); color: var(--text); }
    header { position: sticky; top: 0; z-index: 20; background: linear-gradient(120deg, var(--accent-deep) 0%, #104b77 70%); color: #fff; padding: 14px 20px; box-shadow: var(--shadow); }
    .head-wrap { max-width: 1800px; margin: 0 auto; display: grid; grid-template-columns: 220px 1fr auto; gap: 18px; align-items: center; }
    .brand { min-width: 0; }
    .brand-title { font-size: 20px; font-weight: 700; letter-spacing: .02em; }
    .brand-user { font-size: 12px; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .header-warning-slot { max-width: 1800px; margin: 8px auto 0; padding: 0 20px; min-height: 34px; }
    .balance-alert { opacity: 0; transform: translateY(-2px); transition: opacity .15s ease, transform .15s ease; font-size: 12px; font-weight: 700; color: #7a5300; background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; padding: 8px 10px; pointer-events: none; }
    .balance-alert.show { opacity: 1; transform: translateY(0); }
    .main { max-width: 1800px; margin: 18px auto; padding: 0 20px 40px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; box-shadow: 0 1px 0 rgba(15, 47, 74, 0.04); }
    .topline { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
    .annual-topline-meta { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-left: auto; }
    .annual-metric {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 1px solid #d7e0ea;
      border-radius: 999px;
      background: #f8fbff;
      font-size: 14px;
      color: #48617a;
    }
    .annual-metric strong {
      color: #1f2937;
      font-size: 18px;
      font-variant-numeric: tabular-nums;
    }
    .annual-metric strong.plus { color: var(--income); }
    .annual-metric strong.minus { color: var(--expense); }
    .section-toggle { border: 1px solid var(--line); background: #fff; color: var(--text); padding: 6px 10px; border-radius: 8px; cursor: pointer; font-size: 12px; }
    .collapsed { display: none; }
    .muted { color: var(--muted); font-size: 12px; }

    .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

    .row { display: grid; gap: 10px; grid-template-columns: 1.5fr 1fr 1fr 1fr 1.1fr 1.5fr auto; }
    .workspace.is-edit-mode #entry-form.row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px 10px;
      align-items: flex-start;
    }
    .field { min-width: 0; }
    .field > input,
    .field > select {
      width: 100%;
      min-width: 0;
    }
    .workspace.is-edit-mode .field { flex: 1 1 220px; }
    .workspace.is-edit-mode .field[data-form-field="title"] { flex-basis: 280px; }
    .workspace.is-edit-mode .field[data-form-field="amount"] { flex-basis: 150px; }
    .workspace.is-edit-mode .field[data-form-field="type"] { flex-basis: 140px; }
    .workspace.is-edit-mode .field[data-form-field="labelColor"] { flex-basis: 140px; }
    .workspace.is-edit-mode .field[data-form-field="scheduledDate"] { flex-basis: 180px; }
    .workspace.is-edit-mode .field[data-form-field="note"] { flex-basis: 260px; }
    .workspace.is-edit-mode .field[data-form-field="cfCategory"] { flex-basis: 300px; }
    .workspace.is-edit-mode .field[data-form-field="customerName"] { flex-basis: 220px; }
    .workspace.is-edit-mode .field[data-form-field="staffName"] { flex-basis: 220px; }
    .workspace.is-edit-mode .field[data-form-field="submit"] {
      flex: 0 0 120px;
      align-self: end;
    }
    .workspace.is-edit-mode .field[data-form-field="submit"] .field-hint {
      text-align: center;
    }
    .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
    input, select, button { border-radius: 8px; border: 1px solid #b9c8d9; padding: 9px 10px; font-size: 14px; background: #fff; color: var(--text); }
    input:focus, select:focus, button:focus { outline: 2px solid rgba(15,76,129,.2); outline-offset: 1px; border-color: var(--accent); }
    .field-hint { margin-top: 4px; font-size: 11px; color: var(--muted); min-height: 1.2em; }
    .field-hint.error { color: #8e1f2b; }
    .primary { background: var(--accent); color: #fff; border: 0; font-weight: 700; }
    .primary:hover { background: #0d426f; }
    .secondary { background: #fff; }
    .reset-filter-button {
      background: #eaf2fb;
      border-color: #9bb6d0;
      color: #0f4c81;
      font-weight: 700;
    }
    .reset-filter-button:hover {
      background: #dbe9f7;
    }
    .date-range-filter { display: inline-flex; align-items: center; gap: 6px; }
    .date-range-filter input[type="date"] { padding: 5px 8px; }
    .date-range-sep { color: #64748b; font-weight: 700; }

    .banner { display: none; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; font-size: 13px; }
    .banner.show { display: block; }
    .banner.error { background: var(--err-bg); border: 1px solid var(--err-line); color: #7f1d1d; }
    .banner.warn { background: var(--warn-bg); border: 1px solid var(--warn-line); color: #7a5300; }
    .banner.ok { background: var(--ok-bg); border: 1px solid var(--ok-line); color: #155e36; }
    .section-anchor {
      display: block;
      position: relative;
      top: -88px;
      visibility: hidden;
    }
    .back-to-form {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 40;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 136px;
      padding: 12px 14px;
      border-radius: 999px;
      border: 1px solid rgba(11, 53, 88, 0.18);
      background: rgba(255, 255, 255, 0.96);
      color: var(--accent-deep);
      box-shadow: 0 12px 28px rgba(10, 36, 64, 0.16);
      font-size: 13px;
      font-weight: 700;
      text-decoration: none;
      backdrop-filter: blur(6px);
    }
    .back-to-form:hover {
      background: #ffffff;
      color: var(--accent);
    }

    .table-wrap { overflow: auto; border: 1px solid #e1e8f0; border-radius: 10px; }
    #list-section-body {
      max-height: var(--list-body-max-height, 70vh);
      overflow: auto;
      overscroll-behavior: contain;
    }
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
    #rows th:nth-child(8),
    #rows td:nth-child(8) { min-width: 180px; }
    #list-section-body [data-list-col="title"] {
      width: var(--list-title-col-width);
      min-width: var(--list-title-col-width);
      max-width: var(--list-title-col-width);
    }
    #list-section-body [data-list-col="content"] {
      width: var(--list-content-col-width);
      min-width: var(--list-content-col-width);
      max-width: var(--list-content-col-width);
    }
    #list-section-body [data-list-col="note"] {
      width: var(--list-note-col-width);
      min-width: var(--list-note-col-width);
      max-width: var(--list-note-col-width);
    }
    #list-section-body td[data-list-col="title"] {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #list-section-body td[data-list-col="content"],
    #list-section-body td[data-list-col="note"] {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .resizable-col-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .col-resizer {
      flex: 0 0 auto;
      width: 10px;
      min-width: 10px;
      height: 20px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      cursor: col-resize;
      background: linear-gradient(180deg, rgba(15, 76, 129, 0.10) 0%, rgba(15, 76, 129, 0.22) 100%);
    }
    .col-resizer:hover,
    .col-resizer:focus-visible {
      background: linear-gradient(180deg, rgba(15, 76, 129, 0.20) 0%, rgba(15, 76, 129, 0.34) 100%);
      outline: none;
    }
    #rows th:nth-child(10),
    #rows td:nth-child(10) { white-space: nowrap; min-width: 110px; }
    #rows th:nth-child(14),
    #rows td:nth-child(14) { white-space: nowrap; min-width: 120px; }
    #rows th:nth-child(15),
    #rows td:nth-child(15) { white-space: nowrap; min-width: 210px; }
    #annual-section-body [data-annual-col="title"] {
      width: var(--annual-title-col-width);
      min-width: var(--annual-title-col-width);
      max-width: var(--annual-title-col-width);
    }
    #annual-section-body [data-annual-col="content"] {
      width: var(--annual-content-col-width);
      min-width: var(--annual-content-col-width);
      max-width: var(--annual-content-col-width);
    }
    #annual-section-body th:first-child,
    #annual-section-body td:first-child {
      position: sticky;
      left: 0;
      width: 110px;
      min-width: 110px;
      max-width: 110px;
      white-space: nowrap;
      background: #fff;
      z-index: 1;
    }
    #annual-section-body thead th:first-child {
      background: #f5f8fb;
      z-index: 3;
    }
    #annual-section-body [data-annual-col="type"],
    #annual-section-body [data-annual-col="amount"],
    #annual-section-body [data-annual-col="running"] {
      width: 1%;
      min-width: max-content;
      max-width: max-content;
      white-space: nowrap;
    }
    #annual-section-body [data-annual-col="customer_name"] {
      width: var(--annual-customer-col-width);
      min-width: var(--annual-customer-col-width);
      max-width: var(--annual-customer-col-width);
    }
    #annual-section-body [data-annual-col="note"] {
      width: var(--annual-note-col-width);
      min-width: var(--annual-note-col-width);
      max-width: var(--annual-note-col-width);
    }
    #annual-section-body td[data-annual-col="title"],
    #annual-section-body td[data-annual-col="content"],
    #annual-section-body td[data-annual-col="customer_name"],
    #annual-section-body td[data-annual-col="note"] {
      overflow: hidden;
      text-overflow: ellipsis;
    }
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
    #list-section-body.hide-col-toggle [data-list-col="toggle"] { display: none !important; }
    #list-section-body.hide-col-index [data-list-col="index"] { display: none !important; }
    #list-section-body.hide-col-label [data-list-col="label"] { display: none !important; }
    #list-section-body.hide-col-scheduled_date [data-list-col="scheduled_date"] { display: none !important; }
    #list-section-body.hide-col-type [data-list-col="type"] { display: none !important; }
    #list-section-body.hide-col-cf_category [data-list-col="cf_category"] { display: none !important; }
    #list-section-body.hide-col-title [data-list-col="title"] { display: none !important; }
    #list-section-body.hide-col-content [data-list-col="content"] { display: none !important; }
    #list-section-body.hide-col-amount [data-list-col="amount"] { display: none !important; }
    #list-section-body.hide-col-note [data-list-col="note"] { display: none !important; }
    #list-section-body.hide-col-actual_date [data-list-col="actual_date"] { display: none !important; }
    #list-section-body.hide-col-customer_name [data-list-col="customer_name"] { display: none !important; }
    #list-section-body.hide-col-staff_name [data-list-col="staff_name"] { display: none !important; }
    #list-section-body.hide-col-running [data-list-col="running"] { display: none !important; }
    #list-section-body.hide-col-actions [data-list-col="actions"] { display: none !important; }
    .action-row { display: flex; gap: 4px; flex-wrap: nowrap; }
    .actions button, .actions select { padding: 5px 6px; font-size: 11px; min-width: 0; white-space: nowrap; }
    .label-dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; margin-right: 6px; border: 1px solid rgba(0,0,0,.15); vertical-align: middle; }
    .label-red { background: #ef4444; }
    .label-orange { background: #f97316; }
    .label-yellow { background: #eab308; }
    .label-green { background: #22c55e; }
    .label-blue { background: #3b82f6; }
    .label-purple { background: #a855f7; }
    .label-brown { background: #8b5e3c; }
    .label-pink { background: #ec4899; }
    .label-gray { background: #94a3b8; }
    .label-lightblue { background: #38bdf8; }
    .workspace {
      --workspace-left-width: minmax(0, 1fr);
      --workspace-right-width: minmax(460px, .92fr);
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 14px;
    }
    .workspace.is-edit-mode {
      grid-template-columns: var(--workspace-left-width) 12px var(--workspace-right-width);
      gap: 10px;
      align-items: start;
    }
    .workspace-left { min-width: 0; }
    .workspace-resizer {
      display: none;
      position: sticky;
      top: 18px;
      align-self: stretch;
      min-height: calc(100vh - 36px);
      cursor: col-resize;
      user-select: none;
      touch-action: none;
      z-index: 21;
    }
    .workspace-resizer::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(15, 76, 129, 0.06) 0%, rgba(15, 76, 129, 0.14) 100%);
      transition: background .15s ease, box-shadow .15s ease;
    }
    .workspace-resizer::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 4px;
      height: 64px;
      transform: translate(-50%, -50%);
      border-radius: 999px;
      background: rgba(11, 53, 88, 0.34);
      box-shadow: 0 0 0 1px rgba(255,255,255,.7);
    }
    .workspace-resizer:hover::before,
    .workspace-resizer:focus-visible::before,
    .workspace.is-resizing .workspace-resizer::before {
      background: linear-gradient(180deg, rgba(15, 76, 129, 0.14) 0%, rgba(15, 76, 129, 0.24) 100%);
      box-shadow: 0 0 0 1px rgba(15, 76, 129, 0.16);
    }
    .workspace.is-edit-mode .workspace-resizer { display: block; }
    .workspace-right { display: none; min-width: 0; align-self: start; }
    .workspace.is-edit-mode .workspace-right { display: block; position: sticky; top: 18px; }
    .edit-mode-bar {
      display: none;
      position: sticky;
      top: 86px;
      z-index: 18;
      margin: 0 0 14px;
      padding: 12px 14px;
      border: 1px solid #d4dde7;
      border-radius: 12px;
      background: linear-gradient(180deg, #ffffff 0%, #f7fbff 100%);
      box-shadow: 0 4px 16px rgba(10, 36, 64, 0.06);
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .workspace.is-edit-mode .edit-mode-bar { display: flex; }
    .edit-mode-bar strong { font-size: 13px; color: #23384e; }
    .edit-mode-bar .muted { font-size: 12px; }
    .edit-mode-bar button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 180px;
      padding: 11px 14px;
      border-radius: 10px;
      border: 1px solid #7aa0c7;
      background: #0f4c81;
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      pointer-events: auto;
      position: relative;
      z-index: 19;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .edit-mode-bar button[aria-pressed="true"] { background: #0b3558; border-color: #0b3558; }
    .workspace-right-panel {
      display: flex;
      flex-direction: column;
      gap: 10px;
      height: calc(100vh - 36px);
      max-height: calc(100vh - 36px);
      overflow: hidden;
      min-height: 0;
      align-self: start;
    }
    .workspace-right-frame-stack {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
    }
    .workspace-right-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .workspace-right-frame {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 1px solid #d4dde7;
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 1px 0 rgba(15, 47, 74, 0.04);
    }
    .workspace-right-frame.is-hidden {
      visibility: hidden;
      pointer-events: none;
    }
    .workspace-right-note { font-size: 12px; color: var(--muted); }
    .list-scroll-sync {
      overflow-x: auto;
      overflow-y: hidden;
      height: 14px;
      margin: 0 0 8px;
      border: 1px solid #e1e8f0;
      border-radius: 10px;
      background: #f8fbff;
      scrollbar-gutter: stable both-edges;
    }
    .list-scroll-sync-spacer {
      height: 1px;
      width: 0;
    }

    @media (max-width: 1000px) {
      .head-wrap { grid-template-columns: 1fr; }
      .summary { grid-template-columns: repeat(3, minmax(100px, 1fr)); }
      .row { grid-template-columns: 1fr 1fr; }
      .workspace.is-edit-mode { grid-template-columns: 1fr; }
      .workspace-resizer { display: none !important; }
      .workspace-right-panel { position: static; height: auto; max-height: none; overflow: visible; }
      .workspace-right-frame { min-height: 560px; height: 560px; }
      .list-scroll-sync { position: static; }
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
    .entry-edit-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .entry-edit-grid .field {
      min-width: 0;
    }
    .entry-edit-grid .field > input,
    .entry-edit-grid .field > select,
    .entry-edit-grid .field > textarea {
      width: 100%;
      min-width: 0;
    }
    .entry-edit-grid .full {
      grid-column: 1 / -1;
    }
    .entry-edit-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
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
    .cashflow-import-preview-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 10px;
      background: #fff;
    }
    .cashflow-import-preview-table th,
    .cashflow-import-preview-table td {
      padding: 8px;
      border: 1px solid var(--line);
      vertical-align: middle;
      text-align: left;
    }
    .cashflow-import-preview-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .cashflow-import-preview-badge.warn {
      background: #fff7ed;
      color: #c2410c;
    }
    .cashflow-import-preview-badge.ok {
      background: #ecfdf5;
      color: #047857;
    }
    .cashflow-import-preview-badge.muted {
      background: #f1f5f9;
      color: #475569;
    }
    .cashflow-import-preview-muted {
      color: var(--muted);
      font-size: 12px;
    }
    .import-result-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .import-result-card {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px;
      background: #f9fbfd;
    }
    .import-result-label {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .import-result-value {
      font-size: 22px;
      font-weight: 800;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .import-result-value.ok { color: var(--income); }
    .import-result-value.warn { color: #b26a00; }
    .import-result-value.error { color: var(--expense); }
    .import-result-message {
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #f8fafc;
      color: var(--text);
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 12px;
    }
    .import-result-message.ok { background: var(--ok-bg); border-color: var(--ok-line); color: #155e36; }
    .import-result-message.warn { background: var(--warn-bg); border-color: var(--warn-line); color: #7a5300; }
    .import-result-message.error { background: #fff1f2; border-color: #f3b3bc; color: #9b1c31; }
    .import-result-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 10px;
    }
    .import-result-table th,
    .import-result-table td {
      padding: 8px;
      border: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    .import-result-table th {
      background: #f5f8fb;
      color: #334e68;
      font-weight: 700;
    }
    .import-result-stack {
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 240px;
      overflow: auto;
      background: #0f172a;
      color: #e2e8f0;
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 12px;
      line-height: 1.5;
    }
    @media (max-width: 900px) {
      .import-result-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 560px) {
      .import-result-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
${renderCommonHeaderHtml(email, isAdmin, '/app', { showEditModeBtn: true })}
<div class="header-warning-slot">
  <div id="balance-alert" class="balance-alert">警告: 今月の差引がマイナスです。資金繰りを確認してください。</div>
</div>
  <main class="main">
    <div id="workspace" class="workspace">
    <div class="workspace-left">
    <div id="edit-mode-bar" class="edit-mode-bar" aria-label="編集モード操作">
      <div>
        <strong>編集モード</strong>
        <div class="muted">左の予定一覧でCF区分を調整すると、右の資金繰り表が更新されます。</div>
      </div>
      <button id="edit-mode-toggle-inline" type="button" aria-pressed="false">編集モードを開始</button>
    </div>
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
      <span class="muted">選択中の年の完了済み入出金データを表示します。残高は年初以前を含む累計で計算します。</span>
      <div class="annual-topline-meta" aria-live="polite">
        <span class="annual-metric">本日 <strong id="annual-today-date">-</strong></span>
        <span class="annual-metric">本日時点残高 <strong id="annual-today-balance">¥0</strong></span>
      </div>
      <button id="toggle-annual" class="section-toggle" type="button">展開する</button>
    </div>
    <div class="toolbar" style="margin-bottom:10px; gap:8px; align-items:center;">
      <label for="annual-month-filter" class="muted">表示範囲</label>
      <select id="annual-month-filter" aria-label="年間明細の表示月">
        <option value="all">全件</option>
      </select>
      <span id="annual-filter-caption" class="muted">当月分を表示</span>
    </div>
    <div id="annual-section-body" class="table-wrap collapsed">
      <table>
        <thead><tr><th>日付</th><th data-annual-col="type">区分</th><th data-annual-col="title"><span class="resizable-col-head"><span>件名</span><button id="annual-title-col-resizer" class="col-resizer" type="button" aria-label="年間明細の件名列の幅を調整"></button></span></th><th data-annual-col="content"><span class="resizable-col-head"><span>内容</span><button id="annual-content-col-resizer" class="col-resizer" type="button" aria-label="年間明細の内容列の幅を調整"></button></span></th><th data-annual-col="customer_name"><span class="resizable-col-head"><span>顧客名</span><button id="annual-customer-col-resizer" class="col-resizer" type="button" aria-label="年間明細の顧客名列の幅を調整"></button></span></th><th data-annual-col="amount">金額</th><th data-annual-col="note"><span class="resizable-col-head"><span>メモ</span><button id="annual-note-col-resizer" class="col-resizer" type="button" aria-label="年間明細のメモ列の幅を調整"></button></span></th><th data-annual-col="running">残高</th></tr></thead>
        <tbody id="annual-expense-rows"></tbody>
      </table>
    </div>
  </section>

  <span id="entry-form-anchor" class="section-anchor" aria-hidden="true"></span>
  <section class="panel">
    <div class="topline"><strong>入出金予定の追加</strong><span class="muted">金額は整数（円）で入力</span></div>
    <div class="toolbar" style="margin-bottom:10px;">
      <button id="load-sample" type="button" hidden>サンプルデータ投入</button>
      <button id="clear-sample" type="button" hidden>サンプルデータ削除</button>
      <button id="clear-all-entries" type="button" hidden>予定一覧を全削除</button>
      <input id="rakuraku-csv-file" type="file" accept=".csv,text/csv" />
      <button id="import-rakuraku-csv" type="button">楽楽販売CSV読込</button>
    </div>
    <form id="entry-form" class="row" novalidate>
      <div class="field" data-form-field="title">
        <label for="f-title">件名</label>
        <input id="f-title" name="title" placeholder="例: A社売上入金" required maxlength="80" />
        <div class="field-hint" data-hint-for="title">1-80文字</div>
      </div>
      <div class="field" data-form-field="content">
        <label for="f-content">内容</label>
        <input id="f-content" name="content" placeholder="任意" maxlength="140" />
        <div class="field-hint" data-hint-for="content">0-140文字</div>
      </div>
      <div class="field" data-form-field="amount">
        <label for="f-amount">金額</label>
        <input id="f-amount" name="amount" type="text" inputmode="numeric" placeholder="例: 120,000" required />
        <div class="field-hint" data-hint-for="amount">1円以上の整数</div>
      </div>
      <div class="field" data-form-field="type">
        <label for="f-type">区分</label>
        <select id="f-type" name="type"><option value="income">入金</option><option value="expense" selected>出金</option></select>
        <div class="field-hint" data-hint-for="type">入金 / 出金</div>
      </div>
      <div class="field" data-form-field="labelColor">
        <label for="f-label-color">色ラベル</label>
        <select id="f-label-color" name="labelColor">
          <option value="red">赤</option>
          <option value="orange">橙</option>
          <option value="yellow">黄</option>
          <option value="green">緑</option>
          <option value="blue">青</option>
          <option value="purple">紫</option>
          <option value="brown">茶</option>
          <option value="pink">桃</option>
          <option value="gray">灰</option>
          <option value="lightblue">水</option>
        </select>
        <div class="field-hint" data-hint-for="labelColor">10色から選択</div>
      </div>
      <div class="field" data-form-field="scheduledDate">
        <label for="f-date">予定日</label>
        <input id="f-date" name="scheduledDate" type="date" required />
        <div class="field-hint" data-hint-for="scheduledDate">選択中の年月に合わせて入力</div>
      </div>
      <div class="field" data-form-field="note">
        <label for="f-note">メモ</label>
        <input id="f-note" name="note" placeholder="任意" maxlength="140" />
        <div class="field-hint" data-hint-for="note">0-140文字</div>
      </div>
      <div class="field" data-form-field="cfCategory">
        <label for="f-cf-category">CF区分</label>
        <select id="f-cf-category" name="cfCategory">
          ${renderCfCategoryOptions('', 'income')}
        </select>
        <div class="field-hint" data-hint-for="cfCategory">未設定可。後から一覧で修正できます</div>
      </div>
      <div class="field" data-form-field="customerName">
        <label for="f-customer-name">顧客名</label>
        <input id="f-customer-name" name="customerName" placeholder="任意" maxlength="80" />
        <div class="field-hint" data-hint-for="customerName">0-80文字</div>
      </div>
      <div class="field" data-form-field="staffName">
        <label for="f-staff-name">担当社員名</label>
        <input id="f-staff-name" name="staffName" placeholder="任意" maxlength="80" />
        <div class="field-hint" data-hint-for="staffName">0-80文字</div>
      </div>
      <div class="field" data-form-field="submit">
        <label>&nbsp;</label>
        <button id="submit-btn" class="primary" type="submit">追加</button>
        <div class="field-hint">Enter で追加</div>
      </div>
    </form>
  </section>
  <a href="#entry-form-anchor" class="back-to-form" aria-label="入出金予定の追加へ戻る">一番上に戻る</a>

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
      <input id="list-filter-keyword" type="search" placeholder="件名・内容・メモ・口座名・顧客名・担当社員名で検索" style="min-width:320px;" />
      <select id="list-filter-month" aria-label="月絞り込み">
        <option value="all">月: すべて</option>
      </select>
      <select id="list-filter-day" aria-label="日絞り込み">
        <option value="all">日: すべて</option>
      </select>
      <span class="date-range-filter" title="予定日を年月日〜年月日で絞り込みます">
        <input id="list-filter-date-from" type="date" aria-label="絞り込み開始日" />
        <span class="date-range-sep">〜</span>
        <input id="list-filter-date-to" type="date" aria-label="絞り込み終了日" />
      </span>
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
        <option value="brown">ラベル: 茶</option>
        <option value="pink">ラベル: 桃</option>
        <option value="gray">ラベル: 灰</option>
        <option value="lightblue">ラベル: 水</option>
      </select>
      <select id="list-filter-cf-status" aria-label="CF区分設定有無の絞り込み">
        <option value="all">CF区分: すべて</option>
        <option value="set">CF区分: 設定あり</option>
        <option value="unset">CF区分: 未設定</option>
      </select>
      <button id="list-filter-reset" type="button" class="reset-filter-button">絞り込み解除</button>
      <button id="export-csv" class="secondary" type="button">Excel出力</button>
      <button id="download-master-csv" class="secondary" type="button">マスターダウンロード</button>
      <input id="cashflow-csv-file" type="file" accept=".csv,text/csv" style="display:none" />
      <button id="import-cashflow-csv" class="secondary" type="button">CSV入力</button>
      <button id="csv-help-trigger" class="help-icon" type="button" title="CSV入力規則とCF区分の説明を表示">ⓘ</button>
      <span id="list-filter-caption" class="muted"></span>
    </div>
    <div class="column-toolbar" aria-label="予定一覧の列表示切り替え">
      <span class="muted">列の表示</span>
      <div class="column-toggle-group">
        <button type="button" class="column-toggle" data-list-col-toggle="label">ラベル</button>
        <button type="button" class="column-toggle" data-list-col-toggle="cf_category">CF区分</button>
        <button type="button" class="column-toggle" data-list-col-toggle="content">内容</button>
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
      <button id="bulk-edit-cf-category" type="button">一括でCF区分設定</button>
      <button id="bulk-edit-color" type="button">一括で色設定</button>
      <button id="bulk-complete" type="button">一括で完了</button>
      <button id="bulk-uncomplete" type="button">一括で未完了</button>
      <span id="bulk-selection-caption" class="muted">選択 0 件</span>
    </div>
    <div id="list-scroll-sync" class="list-scroll-sync" aria-label="予定一覧の横スクロール">
      <div id="list-scroll-sync-spacer" class="list-scroll-sync-spacer"></div>
    </div>
    <div id="list-section-body" class="table-wrap">
      <table>
        <thead><tr><th data-list-col="toggle"></th><th data-list-col="index">#</th><th data-list-col="label">ラベル</th><th data-list-col="scheduled_date">予定日</th><th data-list-col="type">区分</th><th data-list-col="cf_category">CF区分</th><th data-list-col="title"><span class="resizable-col-head"><span>件名</span><button id="title-col-resizer" class="col-resizer" type="button" aria-label="件名列の幅を調整"></button></span></th><th data-list-col="content"><span class="resizable-col-head"><span>内容</span><button id="content-col-resizer" class="col-resizer" type="button" aria-label="内容列の幅を調整"></button></span></th><th data-list-col="amount">金額</th><th data-list-col="note"><span class="resizable-col-head"><span>メモ</span><button id="note-col-resizer" class="col-resizer" type="button" aria-label="メモ列の幅を調整"></button></span></th><th data-list-col="actual_date">入出金日</th><th data-list-col="customer_name">顧客名</th><th data-list-col="staff_name">担当</th><th data-list-col="running">残高</th><th data-list-col="actions">操作</th><th data-list-col="select">選択</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div id="list-more-container" class="more-container" style="display: none; text-align: center; padding: 12px 14px 20px;">
      <button type="button" id="list-more-btn" style="padding: 10px 24px; font-size: 14px; font-weight: bold; color: #fff; background: var(--primary-bg, #3b82f6); border: none; border-radius: 8px; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.08); transition: transform 0.1s ease;">もっと見る（残り <span id="list-more-count">0</span> 件）</button>
    </div>
    </section>
  </div>
  <div
    id="workspace-resizer"
    class="workspace-resizer"
    role="separator"
    aria-label="左右ペインの幅を調整"
    aria-orientation="vertical"
    aria-valuemin="35"
    aria-valuemax="70"
    aria-valuenow="54"
    tabindex="0"
  ></div>
  <aside id="workspace-right" class="workspace-right" aria-label="資金繰り表編集モード">
    <div class="workspace-right-panel">
      <div class="workspace-right-head">
        <div>
          <strong>資金繰り表</strong>
          <div class="workspace-right-note">CF区分の変更後にこの表を即時再読み込みします。</div>
        </div>
      </div>
      <div class="workspace-right-frame-stack">
        <iframe id="statement-frame" class="workspace-right-frame" title="資金繰り表編集ビュー" loading="eager" src="about:blank" data-src="/cashflow-statement?embedded=1"></iframe>
        <iframe id="statement-frame-buffer" class="workspace-right-frame is-hidden" title="資金繰り表編集ビュー（読み込み用）" loading="eager" src="about:blank" data-src="/cashflow-statement?embedded=1"></iframe>
      </div>
    </div>
  </aside>
  </div>
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
    <div style="margin-top:18px; padding-top:16px; border-top:1px solid var(--line);">
      <h3 style="margin:0 0 8px; font-size:16px;">CF区分の設定について</h3>
      <p style="font-size:13px; color:var(--muted); margin:0 0 10px;">
        CF区分は、予定一覧の明細を資金繰り表へ反映するための分類です。編集モードでは、予定一覧の各行でCF区分を変更すると、右側の資金繰り表が再計算されます。
      </p>
      <ul style="margin:0; padding-left:18px; color:var(--text); font-size:13px; line-height:1.7;">
        <li>入金系は <code>現金売上</code>、<code>売掛金回収</code> などの入金区分を選びます。</li>
        <li>出金系は <code>現金仕入</code>、<code>人件費支出</code>、<code>銀行借入返済</code> などの出金区分を選びます。</li>
        <li><code>未設定</code> のままだと資金繰り表の集計対象になりません。</li>
      </ul>
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

<div id="import-result-modal" class="modal-overlay">
  <div class="modal-box" style="max-width: 920px; width: 95%;">
    <span id="import-result-close" class="modal-close">&times;</span>
    <h3 id="import-result-title" style="margin-top:0;">CSV取込み結果</h3>
    <div id="import-result-summary" style="font-size:13px; color:var(--muted); margin-bottom:12px;"></div>
    <div id="import-result-body"></div>
    <div style="margin-top:16px; text-align:right;">
      <button id="import-result-ok" type="button" class="primary" style="padding:8px 20px; font-size:13px; cursor:pointer;">閉じる</button>
    </div>
  </div>
</div>

<div id="cashflow-import-preview-modal" class="modal-overlay">
  <div class="modal-box" style="max-width: 1120px; width: 96%;">
    <span id="cashflow-import-preview-close" class="modal-close">&times;</span>
    <h3 id="cashflow-import-preview-title" style="margin-top:0;">CSV取込み確認</h3>
    <div id="cashflow-import-preview-summary" style="font-size:13px; color:var(--muted); margin-bottom:12px;"></div>
    <div id="cashflow-import-preview-body"></div>
    <div style="margin-top:16px; display:flex; justify-content:space-between; gap:12px; align-items:center; flex-wrap:wrap;">
      <span id="cashflow-import-preview-caption" class="cashflow-import-preview-muted">更新候補 0 件</span>
      <div style="display:flex; gap:8px;">
        <button id="cashflow-import-preview-cancel" type="button" class="secondary" style="padding:8px 20px; font-size:13px; cursor:pointer;">キャンセル</button>
        <button id="cashflow-import-preview-submit" type="button" class="primary" style="padding:8px 20px; font-size:13px; cursor:pointer;">インポート実行</button>
      </div>
    </div>
  </div>
</div>

<div id="entry-edit-modal" class="modal-overlay">
  <div class="modal-box" style="max-width: 980px; width: 96%;">
    <span id="entry-edit-close" class="modal-close">&times;</span>
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; flex-wrap:wrap; gap:12px;">
      <div>
        <h3 style="margin-top:0; margin-bottom:4px;">予定一覧の修正</h3>
        <p style="font-size:13px; color:var(--muted); margin:0;">
          ここで1行分の内容をまとめて修正できます。保存すると予定一覧と集計が更新されます。
        </p>
      </div>
      <div class="entry-edit-actions" style="margin-top:0; margin-right:24px; display:flex; gap:8px;">
        <button id="entry-edit-cancel" type="button" class="secondary">キャンセル</button>
        <button id="entry-edit-save" type="submit" form="entry-edit-form" class="primary">保存</button>
      </div>
    </div>
    <form id="entry-edit-form" novalidate>
      <input type="hidden" id="entry-edit-id" name="id" />
      <div id="entry-edit-grid" class="entry-edit-grid">
        <div class="field">
          <label for="entry-edit-title">件名</label>
          <input id="entry-edit-title" name="title" maxlength="120" required />
          <div class="field-hint">1-120文字</div>
        </div>
        <div class="field">
          <label for="entry-edit-content">内容</label>
          <input id="entry-edit-content" name="content" maxlength="140" />
          <div class="field-hint">0-140文字</div>
        </div>
        <div class="field">
          <label for="entry-edit-amount">金額</label>
          <input id="entry-edit-amount" name="amount" type="text" inputmode="numeric" required />
          <div class="field-hint">1円以上の整数</div>
        </div>
        <div class="field">
          <label for="entry-edit-type">区分</label>
          <select id="entry-edit-type" name="type">
            <option value="income">入金</option>
            <option value="expense">出金</option>
          </select>
          <div class="field-hint">入金 / 出金</div>
        </div>
        <div class="field">
          <label for="entry-edit-label-color">色ラベル</label>
          <select id="entry-edit-label-color" name="labelColor">
            <option value="red">赤</option>
            <option value="orange">橙</option>
            <option value="yellow">黄</option>
            <option value="green">緑</option>
            <option value="blue">青</option>
            <option value="purple">紫</option>
            <option value="brown">茶</option>
            <option value="pink">桃</option>
            <option value="gray">灰</option>
            <option value="lightblue">水</option>
          </select>
          <div class="field-hint">10色から選択</div>
        </div>
        <div class="field">
          <label for="entry-edit-scheduled-date">予定日</label>
          <input id="entry-edit-scheduled-date" name="scheduledDate" type="date" required />
          <div class="field-hint">予定日を修正</div>
        </div>
        <div class="field">
          <label for="entry-edit-actual-date">入出金日</label>
          <input id="entry-edit-actual-date" name="actualTransactionDate" type="date" />
          <div class="field-hint">空欄可</div>
        </div>
        <div class="field full">
          <label for="entry-edit-cf-category">CF区分</label>
          <select id="entry-edit-cf-category" name="cfCategory"></select>
          <div class="field-hint">入金 / 出金に応じて候補を切り替えます</div>
        </div>
        <div class="field full">
          <label for="entry-edit-note">メモ</label>
          <input id="entry-edit-note" name="note" maxlength="140" />
          <div class="field-hint">0-140文字</div>
        </div>
        <div class="field">
          <label for="entry-edit-import-management-no">入出金管理No</label>
          <input id="entry-edit-import-management-no" name="importManagementNo" maxlength="80" />
          <div class="field-hint">任意 / 80文字以内</div>
        </div>
        <div class="field">
          <label for="entry-edit-account-name">口座名</label>
          <select id="entry-edit-account-name" name="accountName">
            <option value="">未設定</option>
            <option value="三井住友口座">三井住友口座</option>
            <option value="和気口座">和気口座</option>
            <option value="那須口座">那須口座</option>
          </select>
          <div class="field-hint">任意</div>
        </div>
        <div class="field">
          <label for="entry-edit-customer-name">顧客名</label>
          <input id="entry-edit-customer-name" name="customerName" maxlength="80" />
          <div class="field-hint">0-80文字</div>
        </div>
        <div class="field">
          <label for="entry-edit-staff-name">担当社員名</label>
          <input id="entry-edit-staff-name" name="staffName" maxlength="80" />
          <div class="field-hint">0-80文字</div>
        </div>
        <div class="field">
          <label for="entry-edit-completed">完了状態</label>
          <select id="entry-edit-completed" name="isCompleted">
            <option value="0">未完了</option>
            <option value="1">完了</option>
          </select>
          <div class="field-hint">必要に応じて切り替え</div>
        </div>
      </div>
    </form>
  </div>
</div>

<div id="bulk-cf-category-modal" class="modal-overlay">
  <div class="modal-box" style="max-width: 520px; width: 94%;">
    <span id="bulk-cf-category-close" class="modal-close">&times;</span>
    <h3 style="margin-top:0;">CF区分の一括設定</h3>
    <p id="bulk-cf-category-summary" style="font-size:13px; color:var(--muted); margin-bottom:12px;"></p>
    <div class="field">
      <label for="bulk-cf-category-select">CF区分</label>
      <select id="bulk-cf-category-select" name="bulkCfCategory"></select>
      <div class="field-hint">選択中の区分に応じた候補のみ表示します</div>
    </div>
    <div style="margin-top:16px; display:flex; justify-content:flex-end; gap:8px;">
      <button id="bulk-cf-category-cancel" type="button" class="secondary">キャンセル</button>
      <button id="bulk-cf-category-submit" type="button" class="primary">設定する</button>
    </div>
  </div>
</div>

<div id="bulk-color-modal" class="modal-overlay">
  <div class="modal-box" style="max-width: 520px; width: 94%;">
    <span id="bulk-color-close" class="modal-close">&times;</span>
    <h3 style="margin-top:0;">色の一括設定</h3>
    <p id="bulk-color-summary" style="font-size:13px; color:var(--muted); margin-bottom:12px;"></p>
    <div class="field">
      <label for="bulk-color-select">色ラベル</label>
      <select id="bulk-color-select" name="bulkLabelColor"></select>
      <div class="field-hint">選択した明細に同じ色を設定します</div>
    </div>
    <div style="margin-top:16px; display:flex; justify-content:flex-end; gap:8px;">
      <button id="bulk-color-cancel" type="button" class="secondary">キャンセル</button>
      <button id="bulk-color-submit" type="button" class="primary">設定する</button>
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
  const entryTitleEl = document.getElementById('f-title');
  const entryContentEl = document.getElementById('f-content');
  const entryAmountEl = document.getElementById('f-amount');
  const entryTypeEl = document.getElementById('f-type');
  const entryLabelColorEl = document.getElementById('f-label-color');
  const entryScheduledDateEl = document.getElementById('f-date');
  const entryNoteEl = document.getElementById('f-note');
  const entryCfCategoryEl = document.getElementById('f-cf-category');
  const entryCustomerNameEl = document.getElementById('f-customer-name');
  const entryStaffNameEl = document.getElementById('f-staff-name');
  const balanceAlertEl = document.getElementById('balance-alert');
  const annualExpenseRowsEl = document.getElementById('annual-expense-rows');
  const annualTodayDateEl = document.getElementById('annual-today-date');
  const annualTodayBalanceEl = document.getElementById('annual-today-balance');
  const annualMonthFilterEl = document.getElementById('annual-month-filter');
  const annualFilterCaptionEl = document.getElementById('annual-filter-caption');
  const loadSampleBtn = document.getElementById('load-sample');
  const clearSampleBtn = document.getElementById('clear-sample');
  const clearAllEntriesBtn = document.getElementById('clear-all-entries');
  const rakurakuCsvFileInput = document.getElementById('rakuraku-csv-file');
  const importRakurakuCsvBtn = document.getElementById('import-rakuraku-csv');
  const cashflowCsvFileInput = document.getElementById('cashflow-csv-file');
  const importCashflowCsvBtn = document.getElementById('import-cashflow-csv');
  const downloadMasterCsvBtn = document.getElementById('download-master-csv');
  const csvHelpTrigger = document.getElementById('csv-help-trigger');
  const csvHelpModal = document.getElementById('csv-help-modal');
  const csvHelpClose = document.getElementById('csv-help-close');
  const csvHelpOk = document.getElementById('csv-help-ok');

  const rakurakuDiffModal = document.getElementById('rakuraku-diff-modal');
  const rakurakuDiffRows = document.getElementById('rakuraku-diff-rows');
  const rakurakuNewCount = document.getElementById('rakuraku-new-count');
  const rakurakuDiffSummary = document.getElementById('rakuraku-diff-summary');
  const rakurakuDiffSelectAll = document.getElementById('rakuraku-diff-select-all');
  const importResultModal = document.getElementById('import-result-modal');
  const importResultTitle = document.getElementById('import-result-title');
  const importResultSummary = document.getElementById('import-result-summary');
  const importResultBody = document.getElementById('import-result-body');
  const importResultClose = document.getElementById('import-result-close');
  const importResultOk = document.getElementById('import-result-ok');
  const cashflowImportPreviewModal = document.getElementById('cashflow-import-preview-modal');
  const cashflowImportPreviewTitle = document.getElementById('cashflow-import-preview-title');
  const cashflowImportPreviewSummary = document.getElementById('cashflow-import-preview-summary');
  const cashflowImportPreviewBody = document.getElementById('cashflow-import-preview-body');
  const cashflowImportPreviewCaption = document.getElementById('cashflow-import-preview-caption');
  const cashflowImportPreviewClose = document.getElementById('cashflow-import-preview-close');
  const cashflowImportPreviewCancel = document.getElementById('cashflow-import-preview-cancel');
  const cashflowImportPreviewSubmit = document.getElementById('cashflow-import-preview-submit');
  const entryEditModal = document.getElementById('entry-edit-modal');
  const entryEditForm = document.getElementById('entry-edit-form');
  const entryEditId = document.getElementById('entry-edit-id');
  const entryEditTitle = document.getElementById('entry-edit-title');
  const entryEditContent = document.getElementById('entry-edit-content');
  const entryEditAmount = document.getElementById('entry-edit-amount');
  const entryEditType = document.getElementById('entry-edit-type');
  const entryEditLabelColor = document.getElementById('entry-edit-label-color');
  const entryEditScheduledDate = document.getElementById('entry-edit-scheduled-date');
  const entryEditActualDate = document.getElementById('entry-edit-actual-date');
  const entryEditCfCategory = document.getElementById('entry-edit-cf-category');
  const entryEditNote = document.getElementById('entry-edit-note');
  const entryEditImportManagementNo = document.getElementById('entry-edit-import-management-no');
  const entryEditAccountName = document.getElementById('entry-edit-account-name');
  const entryEditCustomerName = document.getElementById('entry-edit-customer-name');
  const entryEditStaffName = document.getElementById('entry-edit-staff-name');
  const entryEditCompleted = document.getElementById('entry-edit-completed');
  const entryEditCancel = document.getElementById('entry-edit-cancel');
  const entryEditSave = document.getElementById('entry-edit-save');
  const entryEditClose = document.getElementById('entry-edit-close');

  const toggleAnnualBtn = document.getElementById('toggle-annual');
  const toggleListBtn = document.getElementById('toggle-list');
  const sortByDateBtn = document.getElementById('sort-by-date');
  const editModeToggleBtn = document.getElementById('edit-mode-toggle');
  const editModeToggleInlineBtn = document.getElementById('edit-mode-toggle-inline');
  const workspaceEl = document.getElementById('workspace');
  const workspaceResizerEl = document.getElementById('workspace-resizer');
  const titleColResizerEl = document.getElementById('title-col-resizer');
  const contentColResizerEl = document.getElementById('content-col-resizer');
  const noteColResizerEl = document.getElementById('note-col-resizer');
  const annualTitleColResizerEl = document.getElementById('annual-title-col-resizer');
  const annualContentColResizerEl = document.getElementById('annual-content-col-resizer');
  const annualCustomerColResizerEl = document.getElementById('annual-customer-col-resizer');
  const annualNoteColResizerEl = document.getElementById('annual-note-col-resizer');
  const editModeBarEl = document.getElementById('edit-mode-bar');
  const statementFrameEl = document.getElementById('statement-frame');
  const statementFrameBufferEl = document.getElementById('statement-frame-buffer');
  const debugSummaryEl = document.getElementById('debug-summary');
  const debugEntriesEl = document.getElementById('debug-entries');
  const listScrollSyncEl = document.getElementById('list-scroll-sync');
  const listScrollSyncSpacerEl = document.getElementById('list-scroll-sync-spacer');
  const annualSectionBody = document.getElementById('annual-section-body');
  const listSectionBody = document.getElementById('list-section-body');
  const listMoreContainer = document.getElementById('list-more-container');
  const listMoreBtn = document.getElementById('list-more-btn');
  const listMoreCount = document.getElementById('list-more-count');
  const listFilterKeywordEl = document.getElementById('list-filter-keyword');
  const listFilterMonthEl = document.getElementById('list-filter-month');
  const listFilterDayEl = document.getElementById('list-filter-day');
  const listFilterDateFromEl = document.getElementById('list-filter-date-from');
  const listFilterDateToEl = document.getElementById('list-filter-date-to');
  const listFilterTypeEl = document.getElementById('list-filter-type');
  const listFilterCompletedEl = document.getElementById('list-filter-completed');
  const listFilterLabelEl = document.getElementById('list-filter-label');
  const listFilterCfStatusEl = document.getElementById('list-filter-cf-status');
    const listFilterResetBtn = document.getElementById('list-filter-reset');
    const exportCsvBtn = document.getElementById('export-csv');
    const listFilterCaptionEl = document.getElementById('list-filter-caption');
    const listColumnsCollapseBtn = document.getElementById('list-columns-collapse');
    const listColumnsResetBtn = document.getElementById('list-columns-reset');
    const bulkSelectVisibleBtn = document.getElementById('bulk-select-visible');
  const bulkClearSelectionBtn = document.getElementById('bulk-clear-selection');
  const bulkEditDateBtn = document.getElementById('bulk-edit-date');
  const bulkEditActualDateBtn = document.getElementById('bulk-edit-actual-date');
  const bulkEditCfCategoryBtn = document.getElementById('bulk-edit-cf-category');
  const bulkEditColorBtn = document.getElementById('bulk-edit-color');
  const bulkCompleteBtn = document.getElementById('bulk-complete');
  const bulkUncompleteBtn = document.getElementById('bulk-uncomplete');
  const bulkSelectionCaptionEl = document.getElementById('bulk-selection-caption');
  const bulkCfCategoryModal = document.getElementById('bulk-cf-category-modal');
  const bulkCfCategorySummary = document.getElementById('bulk-cf-category-summary');
  const bulkCfCategorySelect = document.getElementById('bulk-cf-category-select');
  const bulkCfCategoryClose = document.getElementById('bulk-cf-category-close');
  const bulkCfCategoryCancel = document.getElementById('bulk-cf-category-cancel');
  const bulkCfCategorySubmit = document.getElementById('bulk-cf-category-submit');
  const bulkColorModal = document.getElementById('bulk-color-modal');
  const bulkColorSummary = document.getElementById('bulk-color-summary');
  const bulkColorSelect = document.getElementById('bulk-color-select');
  const bulkColorClose = document.getElementById('bulk-color-close');
  const bulkColorCancel = document.getElementById('bulk-color-cancel');
  const bulkColorSubmit = document.getElementById('bulk-color-submit');

  const MASTER_CF_CATEGORIES = ${JSON.stringify([
    { key: '', label: '未設定', kind: 'cf_category', target: 'all', description: '未分類の明細', sortOrder: 0 },
    ...CF_INCOME_CATEGORIES.map((label, index) => ({
      key: label,
      label,
      kind: 'cf_category',
      target: 'income',
      description: '入金のCF区分',
      sortOrder: index + 1
    })),
    ...CF_EXPENSE_CATEGORIES.map((label, index) => ({
      key: label,
      label,
      kind: 'cf_category',
      target: 'expense',
      description: '出金のCF区分',
      sortOrder: CF_INCOME_CATEGORIES.length + index + 1
    }))
  ])};
  const MASTER_LABEL_COLORS = ${JSON.stringify(ENTRY_LABEL_COLORS.map((key, index) => ({
    key,
    label: ENTRY_LABEL_COLOR_LABELS[key],
    kind: 'label_color',
    target: 'all',
    description: '予定一覧の色ラベル',
    sortOrder: index + 1
  })))};

  const fmt = new Intl.NumberFormat('ja-JP');
  let entries = [];
  // 楽観的更新: 追加直後のD1読み取り遅延で行が消えないよう、確定前の行を一時保持する。
  const optimisticEntryById = new Map();
  let savingReorder = false;
  let openingBalance = 0;
  let annualTodayBalance = 0;
  let renderRowsTimer = 0;
  let renderAnnualTimer = 0;
  let visibleLimit = 100;
  const selectedEntryIds = new Set();
  const expandedMgmtIds = new Set();
  let lastCheckedVisibleIndex = -1;
  let isEditMode = false;
  let editingEntryId = null;
  let editModeHiddenColumnSnapshot = null;
  let isSyncingListScroll = false;
  let visibleStatementFrameEl = statementFrameEl;
  let hiddenStatementFrameEl = statementFrameBufferEl;
  let statementFrameRefreshSeq = 0;
  let latestStatementFrameRefreshSeq = 0;
  let statementFrameNeedsRefresh = false;
  let statementFrameRefreshTimer = 0;
  let annualEntriesLoadedKey = '';
  let annualDisplayCarryBalance = 0;
  const annualEntriesCache = new Map();
  const annualEntriesRequestCache = new Map();
  let loadAllAbortController = null;
  let loadAllRequestSeq = 0;
  let latestAppliedLoadAllSeq = 0;
  let keywordFilterTimer = 0;
  const TITLE_COL_WIDTH_STORAGE_KEY = 'cashflow-title-col-width-v1';
  const CONTENT_COL_WIDTH_STORAGE_KEY = 'cashflow-content-col-width-v1';
  const NOTE_COL_WIDTH_STORAGE_KEY = 'cashflow-note-col-width-v1';
  const ANNUAL_TITLE_COL_WIDTH_STORAGE_KEY = 'cashflow-annual-title-col-width-v1';
  const ANNUAL_CONTENT_COL_WIDTH_STORAGE_KEY = 'cashflow-annual-content-col-width-v1';
  const ANNUAL_CUSTOMER_COL_WIDTH_STORAGE_KEY = 'cashflow-annual-customer-col-width-v1';
  const ANNUAL_NOTE_COL_WIDTH_STORAGE_KEY = 'cashflow-annual-note-col-width-v1';
  const MIN_TITLE_COL_WIDTH = 140;
  const MAX_TITLE_COL_WIDTH = 520;
  const MIN_CONTENT_COL_WIDTH = 140;
  const MAX_CONTENT_COL_WIDTH = 520;
  const MIN_NOTE_COL_WIDTH = 120;
  const MAX_NOTE_COL_WIDTH = 420;
  const MIN_ANNUAL_TITLE_COL_WIDTH = 140;
  const MAX_ANNUAL_TITLE_COL_WIDTH = 520;
  const MIN_ANNUAL_CONTENT_COL_WIDTH = 140;
  const MAX_ANNUAL_CONTENT_COL_WIDTH = 520;
  const MIN_ANNUAL_CUSTOMER_COL_WIDTH = 120;
  const MAX_ANNUAL_CUSTOMER_COL_WIDTH = 360;
  const MIN_ANNUAL_NOTE_COL_WIDTH = 120;
  const MAX_ANNUAL_NOTE_COL_WIDTH = 420;
  const EDIT_MODE_SPLIT_STORAGE_KEY = 'cashflow-edit-mode-split-v1';
  const ENTRIES_EXPORT_SEQUENCE_STORAGE_KEY = 'cashflow-entries-export-sequence-v1';
  const MIN_EDIT_MODE_LEFT_PERCENT = 35;
  const MAX_EDIT_MODE_LEFT_PERCENT = 70;
  const LIST_COLUMN_STORAGE_KEY = 'cashflow-list-hidden-columns-v1';
  const LIST_COLUMN_HIDE_PRESET = ['label', 'cf_category', 'note', 'actual_date', 'customer_name', 'staff_name', 'running', 'actions'];
  const LIST_COLUMN_LABELS = new Map([
    ['label', 'ラベル'],
    ['cf_category', 'CF区分'],
    ['content', '内容'],
    ['note', 'メモ'],
    ['actual_date', '入出金日'],
    ['customer_name', '顧客名'],
    ['staff_name', '担当'],
    ['running', '残高'],
    ['actions', '操作']
  ]);
  let hiddenListColumns = loadHiddenListColumns();

  const now = new Date();
  initPeriodSelectors(now);
  syncFormDateWithMonth();
  syncEntryCfCategoryOptions();
  syncAnnualMonthFilter();
  setMonthCaption();
  restoreEditMode();
  if (isEditMode) showEditModeColumns();
  syncEditModeUi();
  syncListScrollWidth();
  syncListScrollPositionFromTable();
  applyTitleColumnWidth(loadTitleColumnWidth());
  applyContentColumnWidth(loadContentColumnWidth());
  applyNoteColumnWidth(loadNoteColumnWidth());
  applyAnnualTitleColumnWidth(loadAnnualTitleColumnWidth());
  applyAnnualContentColumnWidth(loadAnnualContentColumnWidth());
  applyAnnualCustomerColumnWidth(loadAnnualCustomerColumnWidth());
  applyAnnualNoteColumnWidth(loadAnnualNoteColumnWidth());
  applyWorkspaceSplit(loadWorkspaceSplitPercent());

  function initPeriodSelectors(d) {
    const y = d.getFullYear();
    yearInput.innerHTML = Array.from({ length: 7 }, (_, i) => y - 3 + i).map((v) => '<option value=\"' + v + '\">' + v + '年</option>').join('');
    yearInput.value = String(y);
  }

  function selectedMonth() {
    return String(yearInput.value) + '-' + fixedMonth;
  }

  function syncAnnualMonthFilter() {
    if (!(annualMonthFilterEl instanceof HTMLSelectElement) || !(yearInput instanceof HTMLSelectElement)) return;
    const defaultValue = String(yearInput.value) + '-' + fixedMonth;
    annualMonthFilterEl.innerHTML = '<option value="all">全件</option>' +
      Array.from({ length: 12 }, (_, i) => {
        const mm = String(i + 1).padStart(2, '0');
        const value = String(yearInput.value) + '-' + mm;
        return '<option value="' + value + '">' + Number(mm) + '月</option>';
      }).join('');
    annualMonthFilterEl.value = defaultValue;
    syncAnnualFilterCaption();
  }

  function syncAnnualFilterCaption() {
    if (!(annualFilterCaptionEl instanceof HTMLElement) || !(annualMonthFilterEl instanceof HTMLSelectElement)) return;
    const value = String(annualMonthFilterEl.value || 'all');
    annualFilterCaptionEl.textContent = value === 'all'
      ? '全件を表示'
      : String(Number(value.slice(5, 7))) + '月分を表示';
  }

  function getAnnualEntriesSelection() {
    const year = String(yearInput.value);
    const monthFilter = annualMonthFilterEl instanceof HTMLSelectElement ? String(annualMonthFilterEl.value || 'all') : 'all';
    const loadKey = year + ':' + monthFilter;
    return { year, monthFilter, loadKey };
  }

  async function fetchAnnualEntriesPayload(options = {}) {
    const { force = false } = options;
    const { year, monthFilter, loadKey } = getAnnualEntriesSelection();
    if (!force && annualEntriesCache.has(loadKey)) {
      return { loadKey, payload: annualEntriesCache.get(loadKey), ok: true };
    }
    if (annualEntriesRequestCache.has(loadKey)) {
      const payload = await annualEntriesRequestCache.get(loadKey);
      return { loadKey, payload, ok: true };
    }
    const request = (async () => {
      const params = new URLSearchParams({ year });
      if (monthFilter) params.set('month', monthFilter);
      const annualRes = await fetch('/api/annual-expense-entries?' + params.toString());
      const payload = annualRes.ok ? await annualRes.json() : { entries: [], carryBalance: 0 };
      if (annualRes.ok) {
        annualEntriesCache.set(loadKey, payload);
      }
      return payload;
    })();
    annualEntriesRequestCache.set(loadKey, request);
    try {
      const payload = await request;
      return { loadKey, payload, ok: true };
    } catch (error) {
      if (force) annualEntriesCache.delete(loadKey);
      throw error;
    } finally {
      annualEntriesRequestCache.delete(loadKey);
    }
  }

  function prefetchAnnualEntries() {
    void fetchAnnualEntriesPayload({ force: true }).catch(() => {});
  }

  function invalidateAnnualEntriesCache() {
    annualEntriesLoadedKey = '';
    annualEntriesCache.clear();
    annualEntriesRequestCache.clear();
  }

  async function refreshAnnualEntriesAfterMutation() {
    invalidateAnnualEntriesCache();
    if (annualSectionBody instanceof HTMLElement && !annualSectionBody.classList.contains('collapsed')) {
      await loadAnnualEntries(true);
    } else {
      prefetchAnnualEntries();
    }
  }

  function normalizeAmountInputValue(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[^\\d]/g, '');
  }

  function formatAmountInputValue(value) {
    const digits = normalizeAmountInputValue(value);
    if (!digits) return '';
    return fmt.format(Number(digits));
  }

  function parseAmountInputValue(value) {
    const digits = normalizeAmountInputValue(value);
    if (!digits) return 0;
    return Number(digits);
  }

  function parseAmountInputState(value) {
    const digits = normalizeAmountInputValue(value);
    return {
      digits,
      amount: digits ? Number(digits) : 0
    };
  }

  function clampTitleColumnWidth(value) {
    const nextValue = Number(value);
    if (!Number.isFinite(nextValue)) return 220;
    return Math.min(MAX_TITLE_COL_WIDTH, Math.max(MIN_TITLE_COL_WIDTH, Math.round(nextValue)));
  }

  function loadTitleColumnWidth() {
    try {
      return clampTitleColumnWidth(localStorage.getItem(TITLE_COL_WIDTH_STORAGE_KEY));
    } catch (_) {
      return 220;
    }
  }

  function saveTitleColumnWidth(value) {
    try {
      localStorage.setItem(TITLE_COL_WIDTH_STORAGE_KEY, String(clampTitleColumnWidth(value)));
    } catch (_) {
      // 保存不能環境では無視
    }
  }

  function applyTitleColumnWidth(value) {
    const nextValue = clampTitleColumnWidth(value);
    document.documentElement.style.setProperty('--list-title-col-width', nextValue + 'px');
    syncListScrollWidth();
    return nextValue;
  }

  function clampContentColumnWidth(value) {
    const nextValue = Number(value);
    if (!Number.isFinite(nextValue)) return 180;
    return Math.min(MAX_CONTENT_COL_WIDTH, Math.max(MIN_CONTENT_COL_WIDTH, Math.round(nextValue)));
  }

  function loadContentColumnWidth() {
    try {
      return clampContentColumnWidth(localStorage.getItem(CONTENT_COL_WIDTH_STORAGE_KEY));
    } catch (_) {
      return 180;
    }
  }

  function saveContentColumnWidth(value) {
    try {
      localStorage.setItem(CONTENT_COL_WIDTH_STORAGE_KEY, String(clampContentColumnWidth(value)));
    } catch (_) {
      // 保存不能環境では無視
    }
  }

  function applyContentColumnWidth(value) {
    const nextValue = clampContentColumnWidth(value);
    document.documentElement.style.setProperty('--list-content-col-width', nextValue + 'px');
    syncListScrollWidth();
    return nextValue;
  }

  function clampNoteColumnWidth(value) {
    const nextValue = Number(value);
    if (!Number.isFinite(nextValue)) return 140;
    return Math.min(MAX_NOTE_COL_WIDTH, Math.max(MIN_NOTE_COL_WIDTH, Math.round(nextValue)));
  }

  function loadNoteColumnWidth() {
    try {
      return clampNoteColumnWidth(localStorage.getItem(NOTE_COL_WIDTH_STORAGE_KEY));
    } catch (_) {
      return 140;
    }
  }

  function saveNoteColumnWidth(value) {
    try {
      localStorage.setItem(NOTE_COL_WIDTH_STORAGE_KEY, String(clampNoteColumnWidth(value)));
    } catch (_) {
      // 保存不能環境では無視
    }
  }

  function applyNoteColumnWidth(value) {
    const nextValue = clampNoteColumnWidth(value);
    document.documentElement.style.setProperty('--list-note-col-width', nextValue + 'px');
    syncListScrollWidth();
    return nextValue;
  }

  function clampAnnualTitleColumnWidth(value) {
    const nextValue = Number(value);
    if (!Number.isFinite(nextValue)) return 220;
    return Math.min(MAX_ANNUAL_TITLE_COL_WIDTH, Math.max(MIN_ANNUAL_TITLE_COL_WIDTH, Math.round(nextValue)));
  }

  function loadAnnualTitleColumnWidth() {
    try {
      return clampAnnualTitleColumnWidth(localStorage.getItem(ANNUAL_TITLE_COL_WIDTH_STORAGE_KEY));
    } catch (_) {
      return 220;
    }
  }

  function saveAnnualTitleColumnWidth(value) {
    try {
      localStorage.setItem(ANNUAL_TITLE_COL_WIDTH_STORAGE_KEY, String(clampAnnualTitleColumnWidth(value)));
    } catch (_) {
      // 保存不能環境では無視
    }
  }

  function applyAnnualTitleColumnWidth(value) {
    const nextValue = clampAnnualTitleColumnWidth(value);
    document.documentElement.style.setProperty('--annual-title-col-width', nextValue + 'px');
    return nextValue;
  }

  function clampAnnualContentColumnWidth(value) {
    const nextValue = Number(value);
    if (!Number.isFinite(nextValue)) return 180;
    return Math.min(MAX_ANNUAL_CONTENT_COL_WIDTH, Math.max(MIN_ANNUAL_CONTENT_COL_WIDTH, Math.round(nextValue)));
  }

  function loadAnnualContentColumnWidth() {
    try {
      return clampAnnualContentColumnWidth(localStorage.getItem(ANNUAL_CONTENT_COL_WIDTH_STORAGE_KEY));
    } catch (_) {
      return 180;
    }
  }

  function saveAnnualContentColumnWidth(value) {
    try {
      localStorage.setItem(ANNUAL_CONTENT_COL_WIDTH_STORAGE_KEY, String(clampAnnualContentColumnWidth(value)));
    } catch (_) {
      // 保存不能環境では無視
    }
  }

  function applyAnnualContentColumnWidth(value) {
    const nextValue = clampAnnualContentColumnWidth(value);
    document.documentElement.style.setProperty('--annual-content-col-width', nextValue + 'px');
    return nextValue;
  }

  function clampAnnualCustomerColumnWidth(value) {
    const nextValue = Number(value);
    if (!Number.isFinite(nextValue)) return 160;
    return Math.min(MAX_ANNUAL_CUSTOMER_COL_WIDTH, Math.max(MIN_ANNUAL_CUSTOMER_COL_WIDTH, Math.round(nextValue)));
  }

  function loadAnnualCustomerColumnWidth() {
    try {
      return clampAnnualCustomerColumnWidth(localStorage.getItem(ANNUAL_CUSTOMER_COL_WIDTH_STORAGE_KEY));
    } catch (_) {
      return 160;
    }
  }

  function saveAnnualCustomerColumnWidth(value) {
    try {
      localStorage.setItem(ANNUAL_CUSTOMER_COL_WIDTH_STORAGE_KEY, String(clampAnnualCustomerColumnWidth(value)));
    } catch (_) {
      // 保存不能環境では無視
    }
  }

  function applyAnnualCustomerColumnWidth(value) {
    const nextValue = clampAnnualCustomerColumnWidth(value);
    document.documentElement.style.setProperty('--annual-customer-col-width', nextValue + 'px');
    return nextValue;
  }

  function clampAnnualNoteColumnWidth(value) {
    const nextValue = Number(value);
    if (!Number.isFinite(nextValue)) return 160;
    return Math.min(MAX_ANNUAL_NOTE_COL_WIDTH, Math.max(MIN_ANNUAL_NOTE_COL_WIDTH, Math.round(nextValue)));
  }

  function loadAnnualNoteColumnWidth() {
    try {
      return clampAnnualNoteColumnWidth(localStorage.getItem(ANNUAL_NOTE_COL_WIDTH_STORAGE_KEY));
    } catch (_) {
      return 160;
    }
  }

  function saveAnnualNoteColumnWidth(value) {
    try {
      localStorage.setItem(ANNUAL_NOTE_COL_WIDTH_STORAGE_KEY, String(clampAnnualNoteColumnWidth(value)));
    } catch (_) {
      // 保存不能環境では無視
    }
  }

  function applyAnnualNoteColumnWidth(value) {
    const nextValue = clampAnnualNoteColumnWidth(value);
    document.documentElement.style.setProperty('--annual-note-col-width', nextValue + 'px');
    return nextValue;
  }

  function syncAmountInputDisplay(input, options = {}) {
    if (!(input instanceof HTMLInputElement)) return;
    if (!options.force && input.dataset.amountComposing === '1') return;
    const digits = normalizeAmountInputValue(input.value);
    if (!digits) {
      if (String(input.value || '').trim() === '') input.value = '';
      return;
    }
    input.value = digits;
  }

  function bindAmountInputFormatting(input) {
    if (!(input instanceof HTMLInputElement)) return;
    input.addEventListener('compositionstart', () => {
      input.dataset.amountComposing = '1';
    });
    input.addEventListener('compositionend', () => {
      input.dataset.amountComposing = '0';
    });
    input.addEventListener('blur', (ev) => {
      syncAmountInputDisplay(ev.target, { force: true });
    });
  }

  function clampWorkspaceSplitPercent(value) {
    const nextValue = Number(value);
    if (!Number.isFinite(nextValue)) return 54;
    return Math.min(MAX_EDIT_MODE_LEFT_PERCENT, Math.max(MIN_EDIT_MODE_LEFT_PERCENT, nextValue));
  }

  function loadWorkspaceSplitPercent() {
    try {
      return clampWorkspaceSplitPercent(localStorage.getItem(EDIT_MODE_SPLIT_STORAGE_KEY));
    } catch (_) {
      return 54;
    }
  }

  function saveWorkspaceSplitPercent(value) {
    try {
      localStorage.setItem(EDIT_MODE_SPLIT_STORAGE_KEY, String(clampWorkspaceSplitPercent(value)));
    } catch (_) {
      // 保存不能環境では無視
    }
  }

  function applyWorkspaceSplit(value) {
    const nextValue = clampWorkspaceSplitPercent(value);
    if (workspaceEl instanceof HTMLElement) {
      workspaceEl.style.setProperty('--workspace-left-width', 'minmax(0, ' + nextValue + '%)');
      workspaceEl.style.setProperty('--workspace-right-width', 'minmax(460px, calc(100% - ' + nextValue + '%))');
    }
    if (workspaceResizerEl instanceof HTMLElement) {
      workspaceResizerEl.setAttribute('aria-valuenow', String(Math.round(nextValue)));
    }
    return nextValue;
  }

  function updateWorkspaceSplitFromPointer(clientX) {
    if (!(workspaceEl instanceof HTMLElement)) return;
    if (window.innerWidth <= 1000) return;
    const rect = workspaceEl.getBoundingClientRect();
    const totalWidth = rect.width - 12;
    if (totalWidth <= 0) return;
    const nextPercent = ((clientX - rect.left) / totalWidth) * 100;
    const applied = applyWorkspaceSplit(nextPercent);
    saveWorkspaceSplitPercent(applied);
  }

  function showBanner(el, type, message) {
    el.className = 'banner show ' + type;
    el.textContent = message;
  }

  function showBannerAndReveal(el, type, message) {
    showBanner(el, type, message);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
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

  function loadEditModePreference() {
    try {
      return localStorage.getItem('cashflow-edit-mode-v1') === '1';
    } catch (_) {
      return false;
    }
  }

  function saveEditModePreference(nextValue) {
    try {
      localStorage.setItem('cashflow-edit-mode-v1', nextValue ? '1' : '0');
    } catch (_) {
      // 保存不能環境では無視
    }
  }

  function restoreEditMode() {
    isEditMode = loadEditModePreference();
  }

  function syncEditModeUi() {
    if (workspaceEl instanceof HTMLElement) {
      workspaceEl.classList.toggle('is-edit-mode', isEditMode);
    }
    if (workspaceResizerEl instanceof HTMLElement) {
      workspaceResizerEl.setAttribute('aria-hidden', isEditMode ? 'false' : 'true');
    }
    if (editModeBarEl instanceof HTMLElement) {
      editModeBarEl.setAttribute('aria-hidden', isEditMode ? 'false' : 'true');
    }
    if (editModeToggleBtn instanceof HTMLButtonElement) {
      editModeToggleBtn.textContent = isEditMode ? '編集モード終了' : '編集モード';
      editModeToggleBtn.setAttribute('aria-pressed', isEditMode ? 'true' : 'false');
    }
    if (editModeToggleInlineBtn instanceof HTMLButtonElement) {
      editModeToggleInlineBtn.textContent = isEditMode ? '編集モードを終了' : '編集モードを開始';
      editModeToggleInlineBtn.setAttribute('aria-pressed', isEditMode ? 'true' : 'false');
    }
    if (visibleStatementFrameEl instanceof HTMLIFrameElement) {
      visibleStatementFrameEl.style.visibility = isEditMode ? 'visible' : 'hidden';
    }
    if (hiddenStatementFrameEl instanceof HTMLIFrameElement) {
      hiddenStatementFrameEl.style.visibility = 'hidden';
    }
    if (isEditMode) {
      applyWorkspaceSplit(loadWorkspaceSplitPercent());
    }
  }

  function syncListScrollWidth() {
    if (!(listSectionBody instanceof HTMLElement) || !(listScrollSyncSpacerEl instanceof HTMLElement)) return;
    const width = Math.max(listSectionBody.scrollWidth, listSectionBody.clientWidth);
    listScrollSyncSpacerEl.style.width = width + 'px';
  }

  function syncListScrollPositionFromTable() {
    if (!(listSectionBody instanceof HTMLElement) || !(listScrollSyncEl instanceof HTMLElement)) return;
    if (isSyncingListScroll) return;
    isSyncingListScroll = true;
    listScrollSyncEl.scrollLeft = listSectionBody.scrollLeft;
    isSyncingListScroll = false;
  }

  function syncTableScrollPositionFromTop() {
    if (!(listSectionBody instanceof HTMLElement) || !(listScrollSyncEl instanceof HTMLElement)) return;
    if (isSyncingListScroll) return;
    isSyncingListScroll = true;
    listSectionBody.scrollLeft = listScrollSyncEl.scrollLeft;
    isSyncingListScroll = false;
  }

  function beginWorkspaceResize(pointerId) {
    if (!(workspaceEl instanceof HTMLElement) || !(workspaceResizerEl instanceof HTMLElement)) return;
    workspaceEl.classList.add('is-resizing');
    workspaceResizerEl.setPointerCapture?.(pointerId);
  }

  function finishWorkspaceResize(pointerId) {
    if (workspaceEl instanceof HTMLElement) {
      workspaceEl.classList.remove('is-resizing');
    }
    if (workspaceResizerEl instanceof HTMLElement && pointerId != null) {
      workspaceResizerEl.releasePointerCapture?.(pointerId);
    }
  }

  function hasStatementFrameSource(frame) {
    if (!(frame instanceof HTMLIFrameElement)) return false;
    const src = String(frame.getAttribute('src') || frame.src || '');
    return src !== '' && !src.startsWith('about:blank');
  }

  function handleStatementFrameLoad(event) {
    const frame = event.target;
    if (!(frame instanceof HTMLIFrameElement) || !hasStatementFrameSource(frame)) return;
    statementFrameNeedsRefresh = false;
  }

  async function loadAnnualEntries(force = false) {
    if (!(annualSectionBody instanceof HTMLElement)) return;
    if (annualSectionBody.classList.contains('collapsed') && !force) return;
    const { loadKey } = getAnnualEntriesSelection();
    if (!force && annualEntriesLoadedKey === loadKey) return;
    try {
      const annualResult = await fetchAnnualEntriesPayload({ force });
      annualDisplayCarryBalance = Number(annualResult.payload.carryBalance || 0);
      renderAnnualExpenses(Array.isArray(annualResult.payload.entries) ? annualResult.payload.entries : []);
      annualEntriesLoadedKey = annualResult.loadKey;
    } catch (_) {
      if (loadAllAbortController?.signal?.aborted) return;
      if (annualEntriesLoadedKey === '') {
        annualDisplayCarryBalance = 0;
        renderAnnualExpenses([]);
      }
    }
  }

  function invalidateStatementFrame() {
    statementFrameNeedsRefresh = true;
    if (!isEditMode) return;
    if (statementFrameRefreshTimer) window.clearTimeout(statementFrameRefreshTimer);
    statementFrameRefreshTimer = window.setTimeout(() => {
      statementFrameRefreshTimer = 0;
      refreshStatementFrame();
    }, 120);
  }

  function refreshStatementFrame() {
    if (!isEditMode || !(visibleStatementFrameEl instanceof HTMLIFrameElement) || !(hiddenStatementFrameEl instanceof HTMLIFrameElement)) return;
    if (statementFrameRefreshTimer) {
      window.clearTimeout(statementFrameRefreshTimer);
      statementFrameRefreshTimer = 0;
    }
    const refreshSeq = ++statementFrameRefreshSeq;
    latestStatementFrameRefreshSeq = refreshSeq;
    const baseUrl = String(visibleStatementFrameEl.dataset.src || '/cashflow-statement?embedded=1');
    const nextUrl = baseUrl + '&t=' + Date.now();
    const nextVisibleFrame = hiddenStatementFrameEl;
    nextVisibleFrame.classList.add('is-hidden');
    nextVisibleFrame.style.visibility = 'hidden';
    nextVisibleFrame.addEventListener('load', function handleLoad() {
      nextVisibleFrame.removeEventListener('load', handleLoad);
      if (!isEditMode || refreshSeq !== latestStatementFrameRefreshSeq) return;
      if (visibleStatementFrameEl instanceof HTMLIFrameElement) {
        visibleStatementFrameEl.style.visibility = 'hidden';
      }
      nextVisibleFrame.classList.remove('is-hidden');
      nextVisibleFrame.style.visibility = 'visible';
      const previousVisible = visibleStatementFrameEl;
      visibleStatementFrameEl = nextVisibleFrame;
      hiddenStatementFrameEl = previousVisible;
      statementFrameNeedsRefresh = false;
      if (hiddenStatementFrameEl instanceof HTMLIFrameElement) {
        hiddenStatementFrameEl.classList.add('is-hidden');
        hiddenStatementFrameEl.style.visibility = 'hidden';
      }
    }, { once: true });
    nextVisibleFrame.src = nextUrl;
  }

  function showEditModeColumns() {
    editModeHiddenColumnSnapshot = new Set(hiddenListColumns);
    if (hiddenListColumns.has('cf_category')) {
      hiddenListColumns.delete('cf_category');
      saveHiddenListColumns();
      syncListColumnToggleUi();
      applyListColumnVisibility();
    }
  }

  function restoreEditModeColumns() {
    if (!editModeHiddenColumnSnapshot) return;
    hiddenListColumns = new Set(editModeHiddenColumnSnapshot);
    editModeHiddenColumnSnapshot = null;
    saveHiddenListColumns();
    syncListColumnToggleUi();
    applyListColumnVisibility();
  }

  function toggleEditMode() {
    isEditMode = !isEditMode;
    if (isEditMode) {
      showEditModeColumns();
      if (statementFrameNeedsRefresh || !hasStatementFrameSource(visibleStatementFrameEl)) {
        refreshStatementFrame();
      }
    } else {
      if (statementFrameRefreshTimer) {
        window.clearTimeout(statementFrameRefreshTimer);
        statementFrameRefreshTimer = 0;
      }
      latestStatementFrameRefreshSeq = ++statementFrameRefreshSeq;
      restoreEditModeColumns();
    }
    saveEditModePreference(isEditMode);
    syncEditModeUi();
  }

  statementFrameEl?.addEventListener('load', handleStatementFrameLoad);
  statementFrameBufferEl?.addEventListener('load', handleStatementFrameLoad);

  window.__toggleEditMode = toggleEditMode;
  editModeToggleBtn?.addEventListener('click', (ev) => {
    ev.preventDefault();
    toggleEditMode();
  });
  editModeToggleInlineBtn?.addEventListener('click', (ev) => {
    ev.preventDefault();
    toggleEditMode();
  });

  function syncFormDateWithMonth() {
    const dateInput = form.elements.scheduledDate;
    if (!dateInput) return;
    const month = selectedMonth();
    if (!month) return;
    if (!dateInput.value || dateInput.value.slice(0, 7) !== month) {
      const [yearText, monthText] = month.split('-');
      const year = Number(yearText);
      const monthIndex = Number(monthText) - 1;
      const today = new Date();
      const lastDay = new Date(year, monthIndex + 1, 0).getDate();
      const day = String(Math.min(today.getDate(), lastDay)).padStart(2, '0');
      dateInput.value = month + '-' + day;
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

  function syncEntryEditCfCategoryOptions(selectedValue) {
    if (!entryEditType || !entryEditCfCategory) return;
    const type = String(entryEditType.value || 'income');
    const selected = typeof selectedValue === 'string'
      ? selectedValue
      : String(entryEditCfCategory.value || '');
    const options = getCfCategoryOptionsByType(type);
    const nextSelected = options.includes(selected) ? selected : '';
    entryEditCfCategory.innerHTML = buildEntryCfCategoryOptionsHtml(nextSelected, type);
    entryEditCfCategory.value = nextSelected;
  }

  function showEntryEditModal(entry) {
    if (!entryEditModal || !entryEditForm) return;
    editingEntryId = Number(entry.id);
    if (entryEditId instanceof HTMLInputElement) entryEditId.value = String(entry.id);
    if (entryEditTitle instanceof HTMLInputElement) entryEditTitle.value = String(entry.title || '');
    if (entryEditContent instanceof HTMLInputElement) entryEditContent.value = String(entry.content || '');
    if (entryEditAmount instanceof HTMLInputElement) entryEditAmount.value = formatAmountInputValue(entry.amount || 0);
    if (entryEditType instanceof HTMLSelectElement) entryEditType.value = String(entry.type || 'income');
    if (entryEditLabelColor instanceof HTMLSelectElement) entryEditLabelColor.value = String(entry.label_color || 'blue');
    if (entryEditScheduledDate instanceof HTMLInputElement) entryEditScheduledDate.value = String(entry.scheduled_date || '');
    if (entryEditActualDate instanceof HTMLInputElement) entryEditActualDate.value = String(entry.actual_transaction_date || '');
    if (entryEditNote instanceof HTMLInputElement) entryEditNote.value = String(entry.note || '');
    if (entryEditImportManagementNo instanceof HTMLInputElement) entryEditImportManagementNo.value = String(entry.import_management_no || '');
    if (entryEditAccountName instanceof HTMLSelectElement) entryEditAccountName.value = String(entry.account_name || '');
    if (entryEditCustomerName instanceof HTMLInputElement) entryEditCustomerName.value = String(entry.customer_name || '');
    if (entryEditStaffName instanceof HTMLInputElement) entryEditStaffName.value = String(entry.staff_name || '');
    if (entryEditCompleted instanceof HTMLSelectElement) entryEditCompleted.value = Number(entry.is_completed) === 1 ? '1' : '0';
    syncEntryEditCfCategoryOptions(String(entry.cf_category || ''));
    entryEditModal.style.display = 'flex';
    window.requestAnimationFrame(() => {
      if (entryEditTitle instanceof HTMLInputElement) entryEditTitle.focus();
    });
  }

  function closeEntryEditModal() {
    if (entryEditModal) entryEditModal.style.display = 'none';
    editingEntryId = null;
  }

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
    for (const key of LIST_COLUMN_LABELS.keys()) {
      table.classList.toggle('hide-col-' + key, hiddenListColumns.has(key));
    }
    syncListColumnToggleUi();
    syncListScrollWidth();
  }

  function validatePayload(payload) {
    const hints = new Map(Array.from(form.querySelectorAll('.field-hint')).map((el) => [el.dataset.hintFor, el]));
    for (const el of hints.values()) el.classList.remove('error');

    if (!payload.title || payload.title.trim().length < 1 || payload.title.trim().length > 80) {
      const hint = hints.get('title'); if (hint) hint.classList.add('error');
      return '件名は1〜80文字で入力してください。';
    }
    if (!Number.isInteger(payload.amount) || payload.amount < 1 || payload.amount > 10000000000) {
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
    if (payload.content.length > 140) {
      const hint = hints.get('content'); if (hint) hint.classList.add('error');
      return '内容は140文字以内で入力してください。';
    }
    const allowedAccounts = new Set(['', '三井住友口座', '和気口座', '那須口座']);
    const allowedColors = new Set(${JSON.stringify([...ENTRY_LABEL_COLORS])});
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

  function buildLabelColorOptionsHtml(selected) {
    return MASTER_LABEL_COLORS.map((item) => (
      '<option value="' + escapeHtml(item.key) + '"' + (item.key === selected ? ' selected' : '') + '>色:' + escapeHtml(item.label) + '</option>'
    )).join('');
  }

  function closeModal(modal) {
    if (modal instanceof HTMLElement) modal.style.display = 'none';
  }

  function openModal(modal) {
    if (modal instanceof HTMLElement) modal.style.display = 'flex';
  }

  function updateSummary(summary) {
    const balance = Number(summary.balance || 0);
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

  function updateAnnualTodayBalanceFromEntries() {
    const todayIso = formatLocalDateIso(new Date());
    const todayLabel = todayIso.replace(/-/g, '/');
    if (annualTodayDateEl instanceof HTMLElement) {
      annualTodayDateEl.textContent = todayLabel;
    }
    if (annualTodayBalanceEl instanceof HTMLElement) {
      annualTodayBalanceEl.textContent = (annualTodayBalance > 0 ? '+' : '') + '¥' + fmt.format(annualTodayBalance);
      annualTodayBalanceEl.classList.remove('plus', 'minus');
      annualTodayBalanceEl.classList.add(annualTodayBalance < 0 ? 'minus' : 'plus');
    }
  }

  async function loadAll() {
    visibleLimit = 100;
    const month = selectedMonth();
    const year = String(yearInput.value);
    if (loadAllAbortController) {
      loadAllAbortController.abort();
    }
    loadAllAbortController = new AbortController();
    const requestSeq = ++loadAllRequestSeq;
    const { signal } = loadAllAbortController;

    try {
      // 数字の計算ロジックは従来と同じ。取得経路だけを「4本並列」から
      // 「集約API 1本」に変更している。集約が使えないときは従来の個別APIへ自動フォールバック。
      let summary = { income: 0, expense: 0, balance: 0 };
      let entriesPayload = { entries: [] };
      let openingPayload = { openingBalance: 0 };
      let todayBalancePayload = { todayBalance: 0 };
      let summaryOk = false;
      let entriesOk = false;
      let bootstrapUsed = false;
      let sectionErrors = null;

      try {
        const bootstrapRes = await fetch(
          '/api/app-bootstrap?year=' + encodeURIComponent(year) + '&month=' + encodeURIComponent(month),
          { signal }
        );
        if (bootstrapRes.ok) {
          const payload = await bootstrapRes.json();
          bootstrapUsed = true;
          summary = payload.summary || summary;
          entriesPayload = { entries: Array.isArray(payload.entries) ? payload.entries : [] };
          openingPayload = { openingBalance: Number(payload.openingBalance || 0) };
          todayBalancePayload = { todayBalance: Number(payload.todayBalance || 0) };
          sectionErrors = payload.errors && typeof payload.errors === 'object' ? payload.errors : null;
          summaryOk = !(sectionErrors && sectionErrors.summary);
          entriesOk = !(sectionErrors && sectionErrors.entries);
        }
      } catch (bootstrapErr) {
        if (bootstrapErr instanceof DOMException && bootstrapErr.name === 'AbortError') throw bootstrapErr;
        console.warn('app-bootstrap 失敗のため個別APIにフォールバックします', bootstrapErr);
      }

      // 集約APIが使えなかった場合のみ、従来の個別API（4本並列）で取得する。
      if (!bootstrapUsed) {
        const [summaryRes, entriesRes, openingRes, todayBalanceRes] = await Promise.all([
          fetch('/api/summary?month=' + encodeURIComponent(month), { signal }),
          fetch('/api/entries?year=' + encodeURIComponent(year), { signal }),
          fetch('/api/opening-balance?month=' + encodeURIComponent(year + '-01'), { signal }),
          fetch('/api/today-balance', { signal })
        ]);
        if (signal.aborted || requestSeq < latestAppliedLoadAllSeq) {
          return false;
        }
        summary = summaryRes.ok ? await summaryRes.json() : summary;
        entriesPayload = entriesRes.ok ? await entriesRes.json() : entriesPayload;
        openingPayload = openingRes.ok ? await openingRes.json() : openingPayload;
        todayBalancePayload = todayBalanceRes.ok ? await todayBalanceRes.json() : todayBalancePayload;
        summaryOk = summaryRes.ok;
        entriesOk = entriesRes.ok;
      }
      if (signal.aborted || requestSeq < latestAppliedLoadAllSeq) {
        return false;
      }
      latestAppliedLoadAllSeq = requestSeq;
      entries = mergeOptimisticEntries(Array.isArray(entriesPayload.entries) ? entriesPayload.entries : [], year);
      openingBalance = Number(openingPayload.openingBalance || 0);
      annualTodayBalance = Number(todayBalancePayload.todayBalance || 0);
      syncMonthFilterOptions();
      syncDayFilterOptions();
      if (debugSummaryEl) {
        debugSummaryEl.textContent = summaryOk
          ? 'income=' + String(Number(summary.income || 0)) + ' expense=' + String(Number(summary.expense || 0)) + ' balance=' + String(Number(summary.balance || 0))
          : 'error';
      }
      if (debugEntriesEl) {
        debugEntriesEl.textContent = entriesOk ? 'count=' + String(entries.length) : 'error';
      }

      updateSummary(summary);

      renderRows();

      syncListScrollPositionFromTable();

      updateSelectedMonthAlert();

      updateAnnualTodayBalanceFromEntries();

      if (annualSectionBody instanceof HTMLElement && !annualSectionBody.classList.contains('collapsed')) {
        await loadAnnualEntries(true);
      } else {
        annualEntriesLoadedKey = '';
        prefetchAnnualEntries();
      }
      if (isEditMode && statementFrameNeedsRefresh) invalidateStatementFrame();
      if (!entriesOk) {
        showBanner(statusBanner, 'error', (sectionErrors && sectionErrors.entries) || '一覧データの取得に失敗しました。再読み込みしてください。');
      } else if (sectionErrors && (sectionErrors.summary || sectionErrors.openingBalance || sectionErrors.todayBalance)) {
        const partialMsgs = [sectionErrors.summary, sectionErrors.openingBalance, sectionErrors.todayBalance].filter(Boolean);
        showBanner(statusBanner, 'error', partialMsgs.join(' / '));
      } else {
        hideBanner(statusBanner);
      }
      return entriesOk;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return false;
      }
      console.error('loadAll failed', err);
      if (entries.length === 0) {
        showBanner(statusBanner, 'error', '一覧の取得に失敗しました。通信状態を確認して再読み込みしてください。');
      } else {
        hideBanner(statusBanner);
      }
      return false;
    }
  }

  function renderAnnualExpenses(rows) {
    if (renderAnnualTimer) {
      window.clearTimeout(renderAnnualTimer);
      renderAnnualTimer = 0;
    }
    updateAnnualTodayBalanceFromEntries();
    if (rows.length === 0) {
      annualExpenseRowsEl.innerHTML = '<tr><td colspan="8" class="muted">この年のデータはありません。</td></tr>';
      return;
    }
    let annualRunning = openingBalance + annualDisplayCarryBalance;
    const chunkSize = 150;
    const initialRows = rows.slice(0, chunkSize);
    annualExpenseRowsEl.innerHTML = initialRows.map((e) => {
      const amount = Number(e.amount || 0);
      annualRunning += e.type === 'income' ? amount : -amount;
      return '<tr>' +
      '<td>' + escapeHtml(e.scheduled_date) + '</td>' +
      '<td data-annual-col="type">' + (e.type === 'income' ? '入金' : '出金') + '</td>' +
      '<td data-annual-col="title">' + escapeHtml(e.title || '') + '</td>' +
      '<td data-annual-col="content">' + escapeHtml(e.content || '') + '</td>' +
      '<td data-annual-col="customer_name">' + escapeHtml(e.customer_name || '') + '</td>' +
      '<td class="amount ' + e.type + '" data-annual-col="amount">' + (e.type === 'income' ? '+' : '-') + fmt.format(amount) + '</td>' +
      '<td data-annual-col="note">' + escapeHtml(e.note || '') + '</td>' +
      '<td class="running ' + (annualRunning < 0 ? 'minus' : 'plus') + '" data-annual-col="running">' + (annualRunning > 0 ? '+' : '') + fmt.format(annualRunning) + '</td>' +
      '</tr>';
    }).join('');

    if (rows.length > chunkSize) {
      let offset = chunkSize;
      function renderNextChunk() {
        const nextRows = rows.slice(offset, offset + chunkSize);
        if (nextRows.length === 0) return;
        const html = nextRows.map((e) => {
          const amount = Number(e.amount || 0);
          annualRunning += e.type === 'income' ? amount : -amount;
          return '<tr>' +
          '<td>' + escapeHtml(e.scheduled_date) + '</td>' +
          '<td data-annual-col="type">' + (e.type === 'income' ? '入金' : '出金') + '</td>' +
          '<td data-annual-col="title">' + escapeHtml(e.title || '') + '</td>' +
          '<td data-annual-col="content">' + escapeHtml(e.content || '') + '</td>' +
          '<td data-annual-col="customer_name">' + escapeHtml(e.customer_name || '') + '</td>' +
          '<td class="amount ' + e.type + '" data-annual-col="amount">' + (e.type === 'income' ? '+' : '-') + fmt.format(amount) + '</td>' +
          '<td data-annual-col="note">' + escapeHtml(e.note || '') + '</td>' +
          '<td class="running ' + (annualRunning < 0 ? 'minus' : 'plus') + '" data-annual-col="running">' + (annualRunning > 0 ? '+' : '') + fmt.format(annualRunning) + '</td>' +
          '</tr>';
        }).join('');
        annualExpenseRowsEl.insertAdjacentHTML('beforeend', html);
        offset += chunkSize;
        if (offset < rows.length) {
          renderAnnualTimer = window.setTimeout(renderNextChunk, 0);
        }
      }
      renderAnnualTimer = window.setTimeout(renderNextChunk, 0);
    }
  }

  function normalizeDate(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(v)) return v;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return formatLocalDateIso(d);
  }

  function formatLocalDateIso(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function nextEntriesExportSequence(year, exportDateKey) {
    const scopeKey = String(year || 'data') + '_' + String(exportDateKey || '').replaceAll('-', '');
    try {
      const raw = localStorage.getItem(ENTRIES_EXPORT_SEQUENCE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const current = Number(parsed && typeof parsed === 'object' ? parsed[scopeKey] : 0);
      const next = Number.isFinite(current) && current > 0 ? current + 1 : 1;
      const nextState = parsed && typeof parsed === 'object' ? parsed : {};
      nextState[scopeKey] = next;
      localStorage.setItem(ENTRIES_EXPORT_SEQUENCE_STORAGE_KEY, JSON.stringify(nextState));
      return next;
    } catch (_) {
      return 1;
    }
  }

  function syncMonthFilterOptions() {
    if (!listFilterMonthEl) return;
    const previous = String(listFilterMonthEl.value || 'all');
    const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
    listFilterMonthEl.innerHTML = '<option value="all">月: すべて</option>' +
      months.map((mm) => '<option value="' + mm + '">' + Number(mm) + '月</option>').join('');
    listFilterMonthEl.value = (previous === 'all' || months.includes(previous)) ? previous : 'all';
  }

  function syncDayFilterOptions() {
    if (!listFilterDayEl) return;
    const previous = String(listFilterDayEl.value || 'all');
    const monthFilter = String(listFilterMonthEl?.value || 'all');
    const year = Number(String(yearInput.value || '').trim()) || new Date().getFullYear();
    const dayCount = monthFilter === 'all'
      ? 31
      : new Date(year, Number(monthFilter), 0).getDate();
    const days = Array.from({ length: dayCount }, (_, i) => String(i + 1).padStart(2, '0'));
    listFilterDayEl.innerHTML = '<option value="all">日: すべて</option>' +
      days.map((dd) => '<option value="' + dd + '">' + Number(dd) + '日</option>').join('');
    listFilterDayEl.value = (previous === 'all' || days.includes(previous)) ? previous : 'all';
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
    const dayFilter = String(listFilterDayEl?.value || 'all');
    const dateFrom = normalizeDate(String(listFilterDateFromEl?.value || ''));
    const dateTo = normalizeDate(String(listFilterDateToEl?.value || ''));
    const typeFilter = String(listFilterTypeEl?.value || 'all');
    const completedFilter = String(listFilterCompletedEl?.value || 'all');
    const labelFilter = String(listFilterLabelEl?.value || 'all');
    const cfStatusFilter = String(listFilterCfStatusEl?.value || 'all');
    return entries.filter((e) => {
      const d = String(e.scheduled_date || '');
      if (monthFilter !== 'all') {
        if (d.slice(5, 7) !== monthFilter) return false;
      }
      if (dayFilter !== 'all' && d.slice(8, 10) !== dayFilter) return false;
      if (dateFrom && (!d || d < dateFrom)) return false;
      if (dateTo && (!d || d > dateTo)) return false;
      if (typeFilter !== 'all' && e.type !== typeFilter) return false;
      const labelColor = String(e.label_color || 'blue');
      if (labelFilter !== 'all' && labelColor !== labelFilter) return false;
      const isDone = Number(e.is_completed) === 1;
      if (completedFilter === 'open' && isDone) return false;
      if (completedFilter === 'done' && !isDone) return false;
      const hasCfCategory = String(e.cf_category || '').trim() !== '';
      if (cfStatusFilter === 'set' && !hasCfCategory) return false;
      if (cfStatusFilter === 'unset' && hasCfCategory) return false;
      if (!keyword) return true;
      const haystack = [
        e.title || '',
        e.content || '',
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

  function patchEntryInMemory(id, patch) {
    entries = entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  }

  function compareEntriesForList(a, b) {
    const da = String(a.scheduled_date || '');
    const db = String(b.scheduled_date || '');
    if (da !== db) return da < db ? -1 : 1;
    const oa = Number(a.order_index || 0);
    const ob = Number(b.order_index || 0);
    if (oa !== ob) return oa - ob;
    return Number(a.id || 0) - Number(b.id || 0);
  }

  // サーバー取得結果に、未反映の楽観的追加行（同一年のみ）を差し込む。
  // 取得結果に既に含まれていれば楽観行は破棄する（重複防止・整合完了）。
  function mergeOptimisticEntries(serverEntries, year) {
    if (optimisticEntryById.size === 0) return serverEntries;
    const presentIds = new Set(serverEntries.map((e) => Number(e.id)));
    const merged = serverEntries.slice();
    let injected = false;
    for (const [oid, oentry] of optimisticEntryById) {
      if (presentIds.has(Number(oid))) {
        optimisticEntryById.delete(oid);
        continue;
      }
      if (String(oentry.scheduled_date || '').slice(0, 4) !== String(year)) continue;
      merged.push(oentry);
      injected = true;
    }
    if (injected) merged.sort(compareEntriesForList);
    return merged;
  }

  function buildRunningBalanceMap() {
    const runningById = new Map();
    let running = openingBalance;
    for (const entry of entries) {
      const amount = Number(entry.amount || 0);
      running += entry.type === 'income' ? amount : -amount;
      runningById.set(entry.id, running);
    }
    return runningById;
  }

  function renderEntryRowHtml(e, idx, entryRunning) {
    const amount = Number(e.amount);
    const runningClass = entryRunning < 0 ? 'minus' : 'plus';
    const rowClass = Number(e.is_completed) === 1 ? 'completed' : '';
    const actionAttrs = 'data-id="' + e.id + '" ' + (savingReorder ? 'disabled' : '');
    const actionBtn = (attr, label) => '<button type="button" ' + attr + ' ' + actionAttrs + '>' + label + '</button>';
    const hasMgmt = String(e.import_management_no || '').trim() !== '';
    const expanded = expandedMgmtIds.has(Number(e.id));
    const toggleLabel = expanded ? '−' : '+';
    const toggleButton = hasMgmt
      ? '<button type="button" class="toggle-mgmt" data-togglemgmt="1" data-id="' + e.id + '">' + toggleLabel + '</button>'
      : '';
    const detailRow = hasMgmt && expanded
      ? '<tr class="detail-row" data-parent-id="' + e.id + '"><td></td><td colspan="15">入出金管理No: ' + escapeHtml(String(e.import_management_no || '')) + '</td></tr>'
      : '';

    return {
      rowHtml:
      '<tr class="' + rowClass + '" data-entry-id="' + e.id + '">' +
          '<td class="toggle-cell" data-list-col="toggle">' + toggleButton + '</td>' +
          '<td data-list-col="index">' + (idx + 1) + '</td>' +
          '<td data-list-col="label">' +
            '<span class="label-dot label-' + escapeHtml(String(e.label_color || 'blue')) + '"></span>' +
          '</td>' +
          '<td data-list-col="scheduled_date">' + escapeHtml(e.scheduled_date) + '</td>' +
          '<td data-list-col="type">' + (e.type === 'income' ? '入金' : '出金') + '</td>' +
          '<td data-list-col="cf_category">' + escapeHtml(e.cf_category || '未設定') + '</td>' +
          '<td data-list-col="title">' + escapeHtml(e.title) + '</td>' +
          '<td data-list-col="content">' + escapeHtml(e.content || '') + '</td>' +
          '<td class="amount ' + e.type + '" data-list-col="amount">' + (e.type === 'income' ? '+' : '-') + fmt.format(amount) + '</td>' +
          '<td data-list-col="note">' + escapeHtml(e.note || '') + '</td>' +
          '<td data-list-col="actual_date">' + escapeHtml(e.actual_transaction_date || '') + '</td>' +
          '<td data-list-col="customer_name">' + escapeHtml(e.customer_name || '') + '</td>' +
          '<td data-list-col="staff_name">' + escapeHtml(e.staff_name || '') + '</td>' +
          '<td class="running ' + runningClass + '" data-list-col="running">' + (entryRunning > 0 ? '+' : '') + fmt.format(entryRunning) + '</td>' +
          '<td class="actions" data-list-col="actions">' +
            '<div class="action-row">' +
              actionBtn('data-move="top"', '先頭') +
              actionBtn('data-move="up"', '上') +
              actionBtn('data-move="down"', '下') +
              actionBtn('data-move="bottom"', '末尾') +
              actionBtn('data-delete="1"', '削除') +
              actionBtn('data-openedit="1"', '修正') +
              actionBtn('data-complete="1"', Number(e.is_completed) === 1 ? '完了済み' : '完了') +
              '<select data-editcolor="1" ' + actionAttrs + '>' +
              buildLabelColorOptionsHtml(String(e.label_color || 'blue')) +
              '</select>' +
            '</div>' +
            '<div class="action-row">' +
              actionBtn('data-editdate="1"', '日付変更') +
              actionBtn('data-editactualdate="1"', '確定日') +
              actionBtn('data-duplicate="1"', '複製') +
              '<select data-editcfcategory="1" ' + actionAttrs + '>' +
              buildCfCategoryOptionsHtml(String(e.cf_category || ''), e.type) +
              '</select>' +
            '</div>' +
          '</td>' +
          '<td class="select-cell" data-list-col="select"><input type="checkbox" data-select-id="' + e.id + '"' + (selectedEntryIds.has(Number(e.id)) ? ' checked' : '') + ' /></td>' +
        '</tr>',
      detailHtml: detailRow
    };
  }

  function patchRenderedRow(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    const filtered = getFilteredEntries();
    const filteredIndex = filtered.findIndex((item) => item.id === id);
    if (filteredIndex < 0) {
      renderRows();
      return;
    }
    const runningById = buildRunningBalanceMap();
    const entryRunning = Number(runningById.get(id) || 0);
    const nodes = rowsEl.querySelectorAll('tr[data-entry-id="' + id + '"], tr[data-parent-id="' + id + '"]');
    const existingMainRow = rowsEl.querySelector('tr[data-entry-id="' + id + '"]');
    if (!(existingMainRow instanceof HTMLTableRowElement)) {
      renderRows();
      return;
    }
    const rendered = renderEntryRowHtml(entry, filteredIndex, entryRunning);
    existingMainRow.outerHTML = rendered.rowHtml + rendered.detailHtml;
    if (nodes.length > 0) {
      syncListScrollWidth();
    }
    applyListColumnVisibility();
    updateBulkSelectionCaption();
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
    if (renderRowsTimer) {
      window.clearTimeout(renderRowsTimer);
      renderRowsTimer = 0;
    }

    if (entries.length === 0) {
      rowsEl.innerHTML = '<tr><td colspan="16" class="muted">データがありません。上のフォームから予定を追加してください。</td></tr>';
      listFilterCaptionEl.textContent = '';
      updateBulkSelectionCaption();
      syncListScrollWidth();
      if (listMoreContainer) listMoreContainer.style.display = 'none';
      return;
    }

    const filtered = getFilteredEntries();

    listFilterCaptionEl.textContent = filtered.length === entries.length
      ? '全件表示'
      : String(filtered.length) + ' / ' + String(entries.length) + '件を表示';

    if (filtered.length === 0) {
      rowsEl.innerHTML = '<tr><td colspan="16" class="muted">絞り込み条件に一致する予定はありません。</td></tr>';
      updateBulkSelectionCaption();
      syncListScrollWidth();
      if (listMoreContainer) listMoreContainer.style.display = 'none';
      return;
    }

    const runningById = buildRunningBalanceMap();

    const toRender = filtered.slice(0, visibleLimit);
    rowsEl.innerHTML = toRender.map((e, idx) => {
      const entryRunning = Number(runningById.get(e.id) || 0);
      const rendered = renderEntryRowHtml(e, idx, entryRunning);
      return rendered.rowHtml + rendered.detailHtml;
    }).join('');

    applyListColumnVisibility();
    updateBulkSelectionCaption();
    syncListScrollWidth();

    if (listMoreContainer && listMoreCount) {
      if (filtered.length > visibleLimit) {
        listMoreContainer.style.display = 'block';
        listMoreCount.textContent = String(filtered.length - visibleLimit);
      } else {
        listMoreContainer.style.display = 'none';
      }
    }
  }

  async function bulkUpdate(action, payload, successMessage) {
    const ids = getSelectedIdsInCurrentEntries();
    if (ids.length === 0) {
      showBannerAndReveal(statusBanner, 'warn', '先に対象行をチェックしてください。');
      return false;
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
        return false;
      }
      showBanner(statusBanner, 'ok', successMessage.replace('{count}', String(ids.length)));
      selectedEntryIds.clear();
      invalidateAnnualEntriesCache();
      await loadAll();
      return true;
    } catch (_) {
      showBanner(statusBanner, 'error', '一括更新中に通信エラーが発生しました。');
      return false;
    }
  }

  function getSelectedEntries() {
    const ids = new Set(getSelectedIdsInCurrentEntries());
    return entries.filter((entry) => ids.has(Number(entry.id)));
  }

  function getSelectedEntryTypeForBulkCf() {
    const selectedEntries = getSelectedEntries();
    if (selectedEntries.length === 0) {
      showBannerAndReveal(statusBanner, 'warn', '先に対象行をチェックしてください。');
      return null;
    }
    const types = [...new Set(selectedEntries.map((entry) => String(entry.type || '')))];
    if (types.length !== 1 || (types[0] !== 'income' && types[0] !== 'expense')) {
      showBannerAndReveal(statusBanner, 'warn', 'CF区分の一括設定は入金のみ、または出金のみを選択してください。');
      return null;
    }
    return { type: types[0], count: selectedEntries.length };
  }

  function showBulkCfCategoryModal() {
    const selection = getSelectedEntryTypeForBulkCf();
    if (!selection) return;
    if (!(bulkCfCategorySelect instanceof HTMLSelectElement)) return;
    bulkCfCategorySelect.innerHTML = buildEntryCfCategoryOptionsHtml('', selection.type);
    bulkCfCategorySelect.value = '';
    if (bulkCfCategorySummary instanceof HTMLElement) {
      bulkCfCategorySummary.textContent = selection.count + '件の' + (selection.type === 'income' ? '入金' : '出金') + '明細に同じCF区分を設定します。';
    }
    openModal(bulkCfCategoryModal);
  }

  function showBulkColorModal() {
    const selectedEntries = getSelectedEntries();
    if (selectedEntries.length === 0) {
      showBannerAndReveal(statusBanner, 'warn', '先に対象行をチェックしてください。');
      return;
    }
    if (bulkColorSelect instanceof HTMLSelectElement) {
      bulkColorSelect.innerHTML = buildLabelColorOptionsHtml('blue');
      bulkColorSelect.value = 'blue';
    }
    if (bulkColorSummary instanceof HTMLElement) {
      bulkColorSummary.textContent = selectedEntries.length + '件の明細に同じ色ラベルを設定します。';
    }
    openModal(bulkColorModal);
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
      invalidateStatementFrame();
      invalidateAnnualEntriesCache();
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
      patchEntryInMemory(id, { is_completed: Number(target.is_completed) === 1 ? 0 : 1 });
      patchRenderedRow(id);
      await refreshAnnualEntriesAfterMutation();
    } catch (_) {
      showBanner(statusBanner, 'error', '完了処理中に通信エラーが発生しました。');
    }
  }

  async function duplicateEntry(id) {
    const target = entries.find((e) => e.id === id);
    if (!target) return;
    const amountValue = Number(target.amount);
    const payload = {
      title: String(target.title || ''),
      content: String(target.content || ''),
      amount: Number.isFinite(amountValue) ? amountValue : 0,
      type: target.type === 'expense' ? 'expense' : 'income',
      scheduledDate: normalizeDate(String(target.scheduled_date || '')),
      note: String(target.note || ''),
      accountName: '',
      customerName: String(target.customer_name || ''),
      staffName: String(target.staff_name || ''),
      labelColor: String(target.label_color || 'blue'),
      cfCategory: String(target.cf_category || '')
    };
    try {
      const res = await fetch('/api/entries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        showBanner(statusBanner, 'error', '複製に失敗しました。');
        return;
      }
      const data = safeJsonParse(await res.text()) || {};
      const newId = Number(data.entry?.id ?? 0);
      // 楽観的更新: サーバー再取得を待たず、複製行を即座に一覧へ反映する。
      // 本番D1の書き込み直後の読み取り遅延で行が出ないのを防ぐ。
      if (newId > 0) {
        const newEntry = {
          ...target,
          id: newId,
          order_index: Number(data.entry?.orderIndex ?? 0),
          account_name: '',
          actual_transaction_date: null,
          is_completed: 0,
          is_sample: 0,
          import_management_no: ''
        };
        optimisticEntryById.set(newId, newEntry);
        entries = [...entries, newEntry].sort(compareEntriesForList);
        renderRows();
      }
      invalidateStatementFrame();
      showBanner(statusBanner, 'ok', '予定を複製しました。');
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', '複製処理中に通信エラーが発生しました。');
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
      invalidateStatementFrame();
      patchEntryInMemory(id, { scheduled_date: normalized });
      patchRenderedRow(id);
      await refreshAnnualEntriesAfterMutation();
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
      patchEntryInMemory(id, { actual_transaction_date: normalized });
      patchRenderedRow(id);
    } catch (_) {
      showBanner(statusBanner, 'error', '実際入出金日の更新中に通信エラーが発生しました。');
    }
  }

  function buildEntryEditPayload() {
    return {
      title: String(entryEditTitle instanceof HTMLInputElement ? entryEditTitle.value : '').trim(),
      content: String(entryEditContent instanceof HTMLInputElement ? entryEditContent.value : '').trim(),
      amount: parseAmountInputValue(entryEditAmount instanceof HTMLInputElement ? entryEditAmount.value : 0),
      type: String(entryEditType instanceof HTMLSelectElement ? entryEditType.value : 'income'),
      scheduledDate: normalizeDate(String(entryEditScheduledDate instanceof HTMLInputElement ? entryEditScheduledDate.value : '')),
      note: String(entryEditNote instanceof HTMLInputElement ? entryEditNote.value : '').trim(),
      importManagementNo: String(entryEditImportManagementNo instanceof HTMLInputElement ? entryEditImportManagementNo.value : '').trim(),
      accountName: String(entryEditAccountName instanceof HTMLSelectElement ? entryEditAccountName.value : ''),
      customerName: String(entryEditCustomerName instanceof HTMLInputElement ? entryEditCustomerName.value : '').trim(),
      staffName: String(entryEditStaffName instanceof HTMLInputElement ? entryEditStaffName.value : '').trim(),
      labelColor: String(entryEditLabelColor instanceof HTMLSelectElement ? entryEditLabelColor.value : 'blue').trim(),
      cfCategory: String(entryEditCfCategory instanceof HTMLSelectElement ? entryEditCfCategory.value : '').trim(),
      actualTransactionDate: normalizeDate(String(entryEditActualDate instanceof HTMLInputElement ? entryEditActualDate.value : '')),
      isCompleted: String(entryEditCompleted instanceof HTMLSelectElement ? entryEditCompleted.value : '0') === '1'
    };
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
    if (btn.dataset.duplicate) {
      duplicateEntry(id);
      return;
    }
    if (btn.dataset.openedit) {
      const target = entries.find((e) => e.id === id);
      if (target) showEntryEditModal(target);
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
      const current = entries.find((entry) => entry.id === id);
      const previousCfCategory = String(current?.cf_category || '');
      try {
        const res = await fetch('/api/entries/' + encodeURIComponent(String(id)) + '/cf-category', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cfCategory })
        });
        if (!res.ok) {
          showBanner(statusBanner, 'error', 'CF区分の更新に失敗しました。');
          target.value = previousCfCategory;
          return;
        }
        patchEntryInMemory(id, { cf_category: cfCategory });
        patchRenderedRow(id);
        invalidateStatementFrame();
      } catch (_) {
        showBanner(statusBanner, 'error', 'CF区分更新中に通信エラーが発生しました。');
        target.value = previousCfCategory;
      }
      return;
    }
    if (!target.dataset.editcolor || !target.dataset.id) return;
    const id = Number(target.dataset.id);
    const labelColor = String(target.value || '').trim();
    const current = entries.find((entry) => entry.id === id);
    const previousLabelColor = String(current?.label_color || 'blue');
    try {
      const res = await fetch('/api/entries/' + encodeURIComponent(String(id)) + '/color', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labelColor })
      });
      if (!res.ok) {
        showBanner(statusBanner, 'error', '色ラベルの更新に失敗しました。');
        target.value = previousLabelColor;
        return;
      }
      patchEntryInMemory(id, { label_color: labelColor });
      patchRenderedRow(id);
    } catch (_) {
      showBanner(statusBanner, 'error', '色ラベル更新中に通信エラーが発生しました。');
      target.value = previousLabelColor;
    }
  });

  entryEditType?.addEventListener('change', () => {
    syncEntryEditCfCategoryOptions();
  });
  entryEditCancel?.addEventListener('click', () => {
    closeEntryEditModal();
  });
  entryEditClose?.addEventListener('click', () => {
    closeEntryEditModal();
  });
  entryEditModal?.addEventListener('click', (ev) => {
    if (ev.target === entryEditModal) closeEntryEditModal();
  });
  entryEditForm?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!(entryEditSave instanceof HTMLButtonElement)) return;
    const id = Number(entryEditId instanceof HTMLInputElement ? entryEditId.value : editingEntryId || 0);
    if (!Number.isInteger(id) || id <= 0) return;
    const payload = buildEntryEditPayload();
    entryEditSave.disabled = true;
    try {
      const res = await fetch('/api/entries/' + encodeURIComponent(String(id)), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const rawBody = await res.text();
      const parsed = safeJsonParse(rawBody) || {};
      if (!res.ok) {
        showBanner(statusBanner, 'error', buildApiErrorMessage(parsed, rawBody, '予定の更新に失敗しました。'));
        return;
      }
      invalidateStatementFrame();
      closeEntryEditModal();
      invalidateAnnualEntriesCache();
      const refreshed = await loadAll();
      if (refreshed) {
        showBanner(statusBanner, 'ok', '予定を更新しました。');
      }
    } catch (_) {
      showBanner(statusBanner, 'error', '予定更新中に通信エラーが発生しました。');
    } finally {
      entryEditSave.disabled = false;
    }
  });

  listScrollSyncEl?.addEventListener('scroll', syncTableScrollPositionFromTop, { passive: true });
  listSectionBody?.addEventListener('scroll', syncListScrollPositionFromTable, { passive: true });
  window.addEventListener('resize', syncListScrollWidth);
  window.addEventListener('resize', () => {
    if (isEditMode) applyWorkspaceSplit(loadWorkspaceSplitPercent());
  });
  bindAmountInputFormatting(form.elements.amount);
  bindAmountInputFormatting(entryEditAmount);

  workspaceResizerEl?.addEventListener('pointerdown', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    if (!isEditMode || window.innerWidth <= 1000) return;
    ev.preventDefault();
    beginWorkspaceResize(ev.pointerId);
    updateWorkspaceSplitFromPointer(ev.clientX);
  });
  workspaceResizerEl?.addEventListener('pointermove', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    if (!isEditMode || window.innerWidth <= 1000) return;
    if ((ev.buttons & 1) !== 1 && ev.pointerType !== 'touch') return;
    if (!(workspaceEl instanceof HTMLElement) || !workspaceEl.classList.contains('is-resizing')) return;
    ev.preventDefault();
    updateWorkspaceSplitFromPointer(ev.clientX);
  });
  workspaceResizerEl?.addEventListener('pointerup', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    finishWorkspaceResize(ev.pointerId);
  });
  workspaceResizerEl?.addEventListener('pointercancel', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    finishWorkspaceResize(ev.pointerId);
  });
  workspaceResizerEl?.addEventListener('keydown', (ev) => {
    if (!(ev instanceof KeyboardEvent)) return;
    if (!isEditMode || window.innerWidth <= 1000) return;
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const current = loadWorkspaceSplitPercent();
    const delta = ev.key === 'ArrowLeft' ? -2 : 2;
    const applied = applyWorkspaceSplit(current + delta);
    saveWorkspaceSplitPercent(applied);
  });
  titleColResizerEl?.addEventListener('pointerdown', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = loadTitleColumnWidth();
    titleColResizerEl.setPointerCapture?.(ev.pointerId);
    const onMove = (moveEv) => {
      if (!(moveEv instanceof PointerEvent)) return;
      const applied = applyTitleColumnWidth(startWidth + (moveEv.clientX - startX));
      saveTitleColumnWidth(applied);
    };
    const onEnd = (endEv) => {
      if (endEv instanceof PointerEvent) {
        titleColResizerEl.releasePointerCapture?.(endEv.pointerId);
      }
      titleColResizerEl.removeEventListener('pointermove', onMove);
      titleColResizerEl.removeEventListener('pointerup', onEnd);
      titleColResizerEl.removeEventListener('pointercancel', onEnd);
    };
    titleColResizerEl.addEventListener('pointermove', onMove);
    titleColResizerEl.addEventListener('pointerup', onEnd);
    titleColResizerEl.addEventListener('pointercancel', onEnd);
  });
  contentColResizerEl?.addEventListener('pointerdown', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = loadContentColumnWidth();
    contentColResizerEl.setPointerCapture?.(ev.pointerId);
    const onMove = (moveEv) => {
      if (!(moveEv instanceof PointerEvent)) return;
      const applied = applyContentColumnWidth(startWidth + (moveEv.clientX - startX));
      saveContentColumnWidth(applied);
    };
    const onEnd = (endEv) => {
      if (endEv instanceof PointerEvent) {
        contentColResizerEl.releasePointerCapture?.(endEv.pointerId);
      }
      contentColResizerEl.removeEventListener('pointermove', onMove);
      contentColResizerEl.removeEventListener('pointerup', onEnd);
      contentColResizerEl.removeEventListener('pointercancel', onEnd);
    };
    contentColResizerEl.addEventListener('pointermove', onMove);
    contentColResizerEl.addEventListener('pointerup', onEnd);
    contentColResizerEl.addEventListener('pointercancel', onEnd);
  });
  noteColResizerEl?.addEventListener('pointerdown', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = loadNoteColumnWidth();
    noteColResizerEl.setPointerCapture?.(ev.pointerId);
    const onMove = (moveEv) => {
      if (!(moveEv instanceof PointerEvent)) return;
      const applied = applyNoteColumnWidth(startWidth + (moveEv.clientX - startX));
      saveNoteColumnWidth(applied);
    };
    const onEnd = (endEv) => {
      if (endEv instanceof PointerEvent) {
        noteColResizerEl.releasePointerCapture?.(endEv.pointerId);
      }
      noteColResizerEl.removeEventListener('pointermove', onMove);
      noteColResizerEl.removeEventListener('pointerup', onEnd);
      noteColResizerEl.removeEventListener('pointercancel', onEnd);
    };
    noteColResizerEl.addEventListener('pointermove', onMove);
    noteColResizerEl.addEventListener('pointerup', onEnd);
    noteColResizerEl.addEventListener('pointercancel', onEnd);
  });
  annualTitleColResizerEl?.addEventListener('pointerdown', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = loadAnnualTitleColumnWidth();
    annualTitleColResizerEl.setPointerCapture?.(ev.pointerId);
    const onMove = (moveEv) => {
      if (!(moveEv instanceof PointerEvent)) return;
      const applied = applyAnnualTitleColumnWidth(startWidth + (moveEv.clientX - startX));
      saveAnnualTitleColumnWidth(applied);
    };
    const onEnd = (endEv) => {
      if (endEv instanceof PointerEvent) {
        annualTitleColResizerEl.releasePointerCapture?.(endEv.pointerId);
      }
      annualTitleColResizerEl.removeEventListener('pointermove', onMove);
      annualTitleColResizerEl.removeEventListener('pointerup', onEnd);
      annualTitleColResizerEl.removeEventListener('pointercancel', onEnd);
    };
    annualTitleColResizerEl.addEventListener('pointermove', onMove);
    annualTitleColResizerEl.addEventListener('pointerup', onEnd);
    annualTitleColResizerEl.addEventListener('pointercancel', onEnd);
  });
  annualContentColResizerEl?.addEventListener('pointerdown', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = loadAnnualContentColumnWidth();
    annualContentColResizerEl.setPointerCapture?.(ev.pointerId);
    const onMove = (moveEv) => {
      if (!(moveEv instanceof PointerEvent)) return;
      const applied = applyAnnualContentColumnWidth(startWidth + (moveEv.clientX - startX));
      saveAnnualContentColumnWidth(applied);
    };
    const onEnd = (endEv) => {
      if (endEv instanceof PointerEvent) {
        annualContentColResizerEl.releasePointerCapture?.(endEv.pointerId);
      }
      annualContentColResizerEl.removeEventListener('pointermove', onMove);
      annualContentColResizerEl.removeEventListener('pointerup', onEnd);
      annualContentColResizerEl.removeEventListener('pointercancel', onEnd);
    };
    annualContentColResizerEl.addEventListener('pointermove', onMove);
    annualContentColResizerEl.addEventListener('pointerup', onEnd);
    annualContentColResizerEl.addEventListener('pointercancel', onEnd);
  });
  annualCustomerColResizerEl?.addEventListener('pointerdown', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = loadAnnualCustomerColumnWidth();
    annualCustomerColResizerEl.setPointerCapture?.(ev.pointerId);
    const onMove = (moveEv) => {
      if (!(moveEv instanceof PointerEvent)) return;
      const applied = applyAnnualCustomerColumnWidth(startWidth + (moveEv.clientX - startX));
      saveAnnualCustomerColumnWidth(applied);
    };
    const onEnd = (endEv) => {
      if (endEv instanceof PointerEvent) {
        annualCustomerColResizerEl.releasePointerCapture?.(endEv.pointerId);
      }
      annualCustomerColResizerEl.removeEventListener('pointermove', onMove);
      annualCustomerColResizerEl.removeEventListener('pointerup', onEnd);
      annualCustomerColResizerEl.removeEventListener('pointercancel', onEnd);
    };
    annualCustomerColResizerEl.addEventListener('pointermove', onMove);
    annualCustomerColResizerEl.addEventListener('pointerup', onEnd);
    annualCustomerColResizerEl.addEventListener('pointercancel', onEnd);
  });
  annualNoteColResizerEl?.addEventListener('pointerdown', (ev) => {
    if (!(ev instanceof PointerEvent)) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = loadAnnualNoteColumnWidth();
    annualNoteColResizerEl.setPointerCapture?.(ev.pointerId);
    const onMove = (moveEv) => {
      if (!(moveEv instanceof PointerEvent)) return;
      const applied = applyAnnualNoteColumnWidth(startWidth + (moveEv.clientX - startX));
      saveAnnualNoteColumnWidth(applied);
    };
    const onEnd = (endEv) => {
      if (endEv instanceof PointerEvent) {
        annualNoteColResizerEl.releasePointerCapture?.(endEv.pointerId);
      }
      annualNoteColResizerEl.removeEventListener('pointermove', onMove);
      annualNoteColResizerEl.removeEventListener('pointerup', onEnd);
      annualNoteColResizerEl.removeEventListener('pointercancel', onEnd);
    };
    annualNoteColResizerEl.addEventListener('pointermove', onMove);
    annualNoteColResizerEl.addEventListener('pointerup', onEnd);
    annualNoteColResizerEl.addEventListener('pointercancel', onEnd);
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    hideBanner(statusBanner);

    const amountEl = document.getElementById('f-amount');
    const titleEl = document.getElementById('f-title');
    const contentEl = document.getElementById('f-content');
    const typeEl = document.getElementById('f-type');
    const dateEl = document.getElementById('f-date');
    const noteEl = document.getElementById('f-note');
    const customerEl = document.getElementById('f-customer-name');
    const staffEl = document.getElementById('f-staff-name');
    const colorEl = document.getElementById('f-label-color');
    const cfCategoryEl = document.getElementById('f-cf-category');

    const rawAmountValue = amountEl && 'value' in amountEl ? String(amountEl.value) : '';
    const amountDigits = normalizeAmountInputValue(rawAmountValue);
    const parsedAmount = amountDigits ? parseInt(amountDigits, 10) : 0;
    const payload = {
      title: titleEl && 'value' in titleEl ? String(titleEl.value).trim() : '',
      content: contentEl && 'value' in contentEl ? String(contentEl.value).trim() : '',
      amount: Number.isFinite(parsedAmount) ? parsedAmount : 0,
      amountDigits: amountDigits,
      type: typeEl && 'value' in typeEl ? String(typeEl.value) : 'income',
      scheduledDate: normalizeDate(dateEl && 'value' in dateEl ? String(dateEl.value) : ''),
      note: noteEl && 'value' in noteEl ? String(noteEl.value).trim() : '',
      accountName: '',
      customerName: customerEl && 'value' in customerEl ? String(customerEl.value).trim() : '',
      staffName: staffEl && 'value' in staffEl ? String(staffEl.value).trim() : '',
      labelColor: colorEl && 'value' in colorEl ? String(colorEl.value) : 'blue',
      cfCategory: cfCategoryEl && 'value' in cfCategoryEl ? String(cfCategoryEl.value) : ''
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
        const rawBody = await res.text();
        const parsed = safeJsonParse(rawBody);
        showBanner(statusBanner, 'error', buildApiErrorMessage(parsed, rawBody, '登録に失敗しました。入力値または権限を確認してください。'));
        return;
      }

      invalidateStatementFrame();
      showBanner(statusBanner, 'ok', '予定を追加しました。');
      form.reset();
      if (form.elements.amount instanceof HTMLInputElement) form.elements.amount.value = '';
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
    syncAnnualMonthFilter();
    annualEntriesLoadedKey = '';
    await loadAll();
  });

  annualMonthFilterEl?.addEventListener('change', async () => {
    syncAnnualFilterCaption();
    annualEntriesLoadedKey = '';
    if (annualSectionBody instanceof HTMLElement && !annualSectionBody.classList.contains('collapsed')) {
      await loadAnnualEntries(true);
    } else {
      prefetchAnnualEntries();
    }
  });

  entryTypeEl?.addEventListener('change', () => {
    syncEntryCfCategoryOptions();
  });


  loadSampleBtn.addEventListener('click', async () => {
    const res = await fetch('/api/sample/load', { method: 'POST' });
    if (res.ok) {
      invalidateStatementFrame();
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
      invalidateStatementFrame();
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
      invalidateStatementFrame();
      showBanner(statusBanner, 'ok', '予定を全削除しました。件数: ' + String(payload.affected || 0));
      await loadAll();
    } else {
      showBanner(statusBanner, 'error', payload.error || '全削除に失敗しました。');
    }
  });
  let pendingImportData = null;
  let pendingCashflowImportPreview = null;

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

  function closeCashflowImportPreviewModal() {
    pendingCashflowImportPreview = null;
    if (cashflowImportPreviewModal) cashflowImportPreviewModal.style.display = 'none';
    if (cashflowCsvFileInput) cashflowCsvFileInput.value = '';
  }

  function syncCashflowImportPreviewSelection() {
    if (!pendingCashflowImportPreview) return;
    const total = pendingCashflowImportPreview.updateEntries.length;
    const checks = document.querySelectorAll('.cashflow-import-update-check');
    let selected = 0;
    checks.forEach((chk) => {
      if (chk.checked) selected += 1;
    });
    if (cashflowImportPreviewCaption) {
      cashflowImportPreviewCaption.textContent = '更新 ' + String(selected) + ' / ' + String(total) + ' 件 / 新規 ' + String(pendingCashflowImportPreview.newEntries.length) + ' 件';
    }
    const selectAll = document.getElementById('cashflow-import-update-select-all');
    if (selectAll instanceof HTMLInputElement) {
      selectAll.checked = total > 0 && selected === total;
      selectAll.indeterminate = selected > 0 && selected < total;
    }
  }

  function showCashflowImportPreviewModal(result) {
    if (!cashflowImportPreviewModal || !cashflowImportPreviewTitle || !cashflowImportPreviewSummary || !cashflowImportPreviewBody) return;
    const newEntries = Array.isArray(result.newEntries) ? result.newEntries : [];
    const updateEntries = Array.isArray(result.updateEntries) ? result.updateEntries : [];
    const rowErrors = Array.isArray(result.rowErrors) ? result.rowErrors : [];
    pendingCashflowImportPreview = { newEntries, updateEntries, rowErrors };

    cashflowImportPreviewTitle.textContent = String(result.title || 'CSV取込み確認');
    cashflowImportPreviewSummary.textContent = String(result.summary || '');

    const stats = result.stats || {};
    const cards = [];
    if (stats.totalRows !== undefined) {
      cards.push('<div class="import-result-card"><div class="import-result-label">対象行</div><div class="import-result-value">' + escapeHtml(String(stats.totalRows ?? 0)) + '</div></div>');
    }
    cards.push('<div class="import-result-card"><div class="import-result-label">新規追加</div><div class="import-result-value ok">' + escapeHtml(String(newEntries.length)) + '</div></div>');
    cards.push('<div class="import-result-card"><div class="import-result-label">更新候補</div><div class="import-result-value warn">' + escapeHtml(String(updateEntries.length)) + '</div></div>');
    cards.push('<div class="import-result-card"><div class="import-result-label">失敗</div><div class="import-result-value error">' + escapeHtml(String(rowErrors.length)) + '</div></div>');

    const updateRowsHtml = updateEntries.map((row, idx) => {
      const statusClass = row.hasDiff ? 'warn' : 'ok';
      const statusLabel = row.hasDiff ? '差分あり' : '同一';
      return [
        '<tr>',
        '<td style="text-align:center;"><input type="checkbox" class="cashflow-import-update-check" data-idx="' + String(idx) + '" checked /></td>',
        '<td>' + escapeHtml(String(row.rowNumber ?? '-')) + '</td>',
        '<td>' + escapeHtml(String(row.id ?? '-')) + '</td>',
        '<td>' + escapeHtml(String(row.managementNoOld || row.managementNo || '')) + '</td>',
        '<td><span class="cashflow-import-preview-badge ' + statusClass + '">' + escapeHtml(statusLabel) + '</span></td>',
        '<td>' + formatDiffCell(row.titleOld, row.title) + '</td>',
        '<td>' + formatDiffCell(row.contentOld || '', row.content || '') + '</td>',
        '<td>' + formatDiffCell(formatCurrency(row.amountOld), formatCurrency(row.amount)) + '</td>',
        '<td>' + formatDiffCell(row.scheduledDateOld, row.scheduledDate) + '</td>',
        '<td>' + formatDiffCell(row.customerNameOld || '', row.customerName || '') + '</td>',
        '</tr>'
      ].join('');
    }).join('');

    const rowErrorHtml = rowErrors.length > 0
      ? [
          '<div style="margin-top:12px;">',
          '<div style="font-weight:700; margin-bottom:8px;">行エラー</div>',
          '<div class="table-wrap" style="overflow:auto; border:1px solid var(--line); border-radius:10px;">',
          '<table class="import-result-table">',
          '<thead><tr><th>行</th><th>内容</th></tr></thead>',
          '<tbody>',
          rowErrors.slice(0, 20).map((row) => '<tr><td>' + escapeHtml(String(row.rowNumber ?? '-')) + '</td><td>' + escapeHtml(String(row.message ?? '')) + '</td></tr>').join(''),
          rowErrors.length > 20 ? '<tr><td colspan="2" class="muted">他 ' + String(rowErrors.length - 20) + ' 件</td></tr>' : '',
          '</tbody></table></div></div>'
        ].join('')
      : '';

    cashflowImportPreviewBody.innerHTML = [
      '<div class="import-result-grid">',
      cards.join(''),
      '</div>',
      '<div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:8px;">',
      '<span class="cashflow-import-preview-muted">新規は自動で追加されます。更新候補は必要なものだけ選択してください。</span>',
      '<label style="display:flex; align-items:center; gap:6px; font-size:13px; white-space:nowrap;"><input type="checkbox" id="cashflow-import-update-select-all" ' + (updateEntries.length > 0 ? 'checked' : '') + ' /> すべて選択</label>',
      '</div>',
      '<div class="table-wrap" style="max-height: 50vh; overflow-y: auto;">',
      '<table class="cashflow-import-preview-table">',
      '<thead>',
      '<tr style="background:#f5f8fb; color:#334e68; font-weight:700;">',
      '<th style="width:50px; text-align:center;">選択</th>',
      '<th style="width:64px;">行</th>',
      '<th style="width:80px;">ID</th>',
      '<th style="width:120px;">管理番号</th>',
      '<th style="width:88px;">状態</th>',
      '<th>件名 (DB &rarr; CSV)</th>',
      '<th>内容 (DB &rarr; CSV)</th>',
      '<th>金額 (DB &rarr; CSV)</th>',
      '<th>予定日 (DB &rarr; CSV)</th>',
      '<th>顧客名 (DB &rarr; CSV)</th>',
      '</tr>',
      '</thead>',
      '<tbody>',
      updateRowsHtml || '<tr><td colspan="10" class="muted" style="padding:12px;">更新候補はありません。</td></tr>',
      '</tbody>',
      '</table>',
      '</div>',
      rowErrorHtml
    ].join('');

    cashflowImportPreviewModal.style.display = 'flex';
    const selectAll = document.getElementById('cashflow-import-update-select-all');
    if (selectAll instanceof HTMLInputElement) {
      selectAll.addEventListener('change', () => {
        const checks = document.querySelectorAll('.cashflow-import-update-check');
        checks.forEach((chk) => {
          chk.checked = selectAll.checked;
        });
        syncCashflowImportPreviewSelection();
      });
    }
    const checks = document.querySelectorAll('.cashflow-import-update-check');
    checks.forEach((chk) => {
      chk.addEventListener('change', syncCashflowImportPreviewSelection);
    });
    syncCashflowImportPreviewSelection();
  }

  function closeImportResultModal() {
    if (importResultModal) importResultModal.style.display = 'none';
  }

  function showImportResultModal(result) {
    if (!importResultModal || !importResultTitle || !importResultSummary || !importResultBody) return;
    const status = String(result.status || 'info');
    const title = String(result.title || 'CSV取込み結果');
    importResultTitle.textContent = title;
    importResultSummary.textContent = String(result.summary || '');
    const stats = result.stats || {};
    const rows = Array.isArray(result.rowErrors) ? result.rowErrors : [];
    const limit = 20;
    const rowErrorItems = rows.slice(0, limit).map((row) => '<tr><td>' + escapeHtml(String(row.rowNumber ?? '-')) + '</td><td>' + escapeHtml(String(row.message ?? '')) + '</td></tr>').join('');
    const rowErrorsHtml = rows.length > 0
      ? [
          '<div style="margin-top:12px;">',
          '<div style="font-weight:700; margin-bottom:8px;">行エラー</div>',
          '<div style="overflow:auto; border:1px solid var(--line); border-radius:10px;">',
          '<table class="import-result-table">',
          '<thead><tr><th>行</th><th>内容</th></tr></thead>',
          '<tbody>',
          rowErrorItems,
          rows.length > limit ? '<tr><td colspan="2" class="muted">他 ' + String(rows.length - limit) + ' 件</td></tr>' : '',
          '</tbody></table></div></div>'
        ].join('')
      : '';

    const labels = {
      totalRows: '取込対象行',
      insertedEntries: '新規追加',
      updatedEntries: '更新',
      failedRows: '失敗',
      invalidRows: '無効行',
      skippedRows: 'スキップ',
      importedRawRows: '読込行',
      insertedCount: '新規追加',
      updatedCount: '更新'
    };

    const detailRows = Object.entries(stats)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => '<tr><th>' + escapeHtml(labels[key] || key) + '</th><td>' + escapeHtml(String(value)) + '</td></tr>')
      .join('');

    const messageHtml = result.message
      ? '<div class="import-result-message ' + escapeHtml(status) + '">' + escapeHtml(String(result.message)) + '</div>'
      : '';

    const stackHtml = result.stack
      ? '<div style="margin-top:12px;"><div style="font-weight:700; margin-bottom:8px;">詳細</div><div class="import-result-stack">' + escapeHtml(String(result.stack)) + '</div></div>'
      : '';

    const cards = [];
    if (stats.insertedEntries !== undefined) {
      cards.push('<div class="import-result-card"><div class="import-result-label">新規追加</div><div class="import-result-value ok">' + escapeHtml(String(stats.insertedEntries ?? 0)) + '</div></div>');
    }
    if (stats.updatedEntries !== undefined) {
      cards.push('<div class="import-result-card"><div class="import-result-label">更新</div><div class="import-result-value warn">' + escapeHtml(String(stats.updatedEntries ?? 0)) + '</div></div>');
    }
    if (stats.failedRows !== undefined) {
      cards.push('<div class="import-result-card"><div class="import-result-label">失敗</div><div class="import-result-value error">' + escapeHtml(String(stats.failedRows ?? 0)) + '</div></div>');
    }
    if (stats.totalRows !== undefined) {
      cards.push('<div class="import-result-card"><div class="import-result-label">取込対象行</div><div class="import-result-value">' + escapeHtml(String(stats.totalRows ?? 0)) + '</div></div>');
    }

    importResultBody.innerHTML = [
      messageHtml,
      cards.length > 0 ? '<div class="import-result-grid">' + cards.join('') + '</div>' : '',
      detailRows ? '<div style="margin-top:12px; overflow:auto; border:1px solid var(--line); border-radius:10px;"><table class="import-result-table"><tbody>' + detailRows + '</tbody></table></div>' : '',
      stackHtml,
      rowErrorsHtml
    ].join('');
    importResultModal.style.display = 'flex';
  }

  function collectCashflowImportPreviewSelection() {
    if (!pendingCashflowImportPreview) {
      return { newEntries: [], updateEntries: [] };
    }
    const selectedUpdateEntries = [];
    const checks = document.querySelectorAll('.cashflow-import-update-check');
    checks.forEach((chk) => {
      if (!(chk instanceof HTMLInputElement) || !chk.checked) return;
      const idx = Number(chk.dataset.idx);
      if (!Number.isInteger(idx)) return;
      const row = pendingCashflowImportPreview?.updateEntries[idx];
      if (!row) return;
      selectedUpdateEntries.push({
        rowNumber: row.rowNumber,
        id: row.id,
        title: row.title,
        content: row.content,
        amount: row.amount,
        type: row.type,
        scheduledDate: row.scheduledDate,
        note: row.note,
        actualDate: row.actualDate,
        customerName: row.customerName,
        staffName: row.staffName,
        labelColor: row.labelColor,
        cfCategory: row.cfCategory,
        isCompleted: row.isCompleted,
        managementNo: row.managementNo
      });
    });
    return {
      newEntries: pendingCashflowImportPreview.newEntries.map((row) => ({
        rowNumber: row.rowNumber,
        title: row.title,
        content: row.content,
        amount: row.amount,
        type: row.type,
        scheduledDate: row.scheduledDate,
        note: row.note,
        actualDate: row.actualDate,
        customerName: row.customerName,
        staffName: row.staffName,
        labelColor: row.labelColor,
        cfCategory: row.cfCategory,
        isCompleted: row.isCompleted,
        managementNo: row.managementNo
      })),
      updateEntries: selectedUpdateEntries
    };
  }

  async function commitCashflowImport() {
    if (!pendingCashflowImportPreview) return;
    const selection = collectCashflowImportPreviewSelection();
    if (selection.newEntries.length === 0 && selection.updateEntries.length === 0) {
      showBanner(statusBanner, 'warn', '反映対象が選択されていません。');
      return;
    }
    if (cashflowImportPreviewSubmit) cashflowImportPreviewSubmit.disabled = true;
    try {
      const res = await fetch('/api/import/cashflow/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selection)
      });
      const rawBody = await res.text();
      const payload = safeJsonParse(rawBody) || {};
      if (!res.ok || !payload.ok) {
        showImportResultModal({
          title: 'CSV取込み結果',
          status: 'error',
          message: buildApiErrorMessage(payload, rawBody, 'インポートの確定に失敗しました。'),
          summary: 'CSVの確定処理でエラーが発生しました。',
          stats: {
            httpStatus: res.status,
            errorCode: payload.errorCode || '',
            requestId: payload.requestId || ''
          },
          stack: payload.stack || rawBody
        });
        return;
      }
      closeCashflowImportPreviewModal();
      invalidateStatementFrame();
      showImportResultModal({
        title: 'CSV取込み結果',
        status: 'ok',
        message: 'CSV取込みが完了しました。',
        summary: '新規追加 ' + String(payload.insertedCount || 0) + ' 件 / 更新 ' + String(payload.updatedCount || 0) + ' 件',
        stats: {
          insertedCount: payload.insertedCount || 0,
          updatedCount: payload.updatedCount || 0
        }
      });
      await loadAll();
    } catch (_) {
      showBanner(statusBanner, 'error', 'インポートの確定中にエラーが発生しました。');
    } finally {
      if (cashflowImportPreviewSubmit) cashflowImportPreviewSubmit.disabled = false;
    }
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
      invalidateStatementFrame();
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
  importResultClose?.addEventListener('click', closeImportResultModal);
  importResultOk?.addEventListener('click', closeImportResultModal);
  importResultModal?.addEventListener('click', (ev) => {
    if (ev.target === importResultModal) closeImportResultModal();
  });
  cashflowImportPreviewClose?.addEventListener('click', closeCashflowImportPreviewModal);
  cashflowImportPreviewCancel?.addEventListener('click', closeCashflowImportPreviewModal);
  cashflowImportPreviewSubmit?.addEventListener('click', commitCashflowImport);
  cashflowImportPreviewModal?.addEventListener('click', (ev) => {
    if (ev.target === cashflowImportPreviewModal) closeCashflowImportPreviewModal();
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
      const res = await fetch('/api/import/cashflow/preview', {
        method: 'POST',
        body: formData
      });
      const rawBody = await res.text();
      const payload = safeJsonParse(rawBody) || {};
      if (!res.ok || !payload.ok) {
        showImportResultModal({
          title: 'CSV取込み結果',
          status: 'error',
          message: buildApiErrorMessage(payload, rawBody, 'CSV取り込みに失敗しました。'),
          summary: 'CSV取り込みに失敗しました。下記の内容を確認してください。',
          stats: {
            httpStatus: res.status,
            errorCode: payload.errorCode || '',
            requestId: payload.requestId || ''
          },
          stack: payload.stack || rawBody
        });
        return;
      }
      const newEntries = Array.isArray(payload.newEntries) ? payload.newEntries : [];
      const updateEntries = Array.isArray(payload.updateEntries) ? payload.updateEntries : [];
      const rowErrors = Array.isArray(payload.rowErrors) ? payload.rowErrors : [];
      const hasImportableRows = newEntries.length > 0 || updateEntries.length > 0;
      if (!hasImportableRows) {
        showImportResultModal({
          title: 'CSV取込み結果',
          status: rowErrors.length > 0 ? 'warn' : 'ok',
          message: rowErrors.length > 0
            ? 'CSV取込み対象の行はありませんでした。'
            : 'CSV取込み対象の新規データ、または更新対象データはありませんでした。',
          summary: rowErrors.length > 0
            ? '行エラーを確認してください。'
            : '取り込み結果を確認してください。',
          stats: {
            totalRows: payload.totalRows ?? '',
            invalidRows: payload.invalidRows ?? '',
            skippedRows: payload.skippedRows ?? ''
          },
          rowErrors
        });
        return;
      }
      showCashflowImportPreviewModal({
        title: 'CSV取込み確認',
        summary: '新規データは自動で追加されます。更新候補は必要なものだけ選択してください。',
        stats: {
          totalRows: payload.totalRows ?? '',
          invalidRows: payload.invalidRows ?? '',
          skippedRows: payload.skippedRows ?? ''
        },
        newEntries,
        updateEntries,
        rowErrors
      });
    } catch (_) {
      showImportResultModal({
        title: 'CSV取込み結果',
        status: 'error',
        message: 'CSV読み込み中に通信エラーが発生しました。',
        summary: '通信エラーのため取込み結果を取得できませんでした。',
        stats: {}
      });
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
    if (keywordFilterTimer) window.clearTimeout(keywordFilterTimer);
    keywordFilterTimer = window.setTimeout(() => {
      keywordFilterTimer = 0;
      renderRows();
    }, 180);
  });
  listFilterMonthEl?.addEventListener('change', () => {
    syncDayFilterOptions();
    renderRows();
    updateSelectedMonthAlert();
  });
  [
    listFilterDayEl,
    listFilterDateFromEl,
    listFilterDateToEl,
    listFilterTypeEl,
    listFilterCompletedEl,
    listFilterLabelEl,
    listFilterCfStatusEl
  ].forEach((el) => {
    el?.addEventListener('change', () => {
      renderRows();
    });
  });
  listFilterResetBtn?.addEventListener('click', () => {
    listFilterKeywordEl.value = '';
    listFilterMonthEl.value = 'all';
    if (listFilterDayEl) listFilterDayEl.value = 'all';
    if (listFilterDateFromEl) listFilterDateFromEl.value = '';
    if (listFilterDateToEl) listFilterDateToEl.value = '';
    listFilterTypeEl.value = 'all';
    listFilterCompletedEl.value = 'all';
    listFilterLabelEl.value = 'all';
    if (listFilterCfStatusEl) listFilterCfStatusEl.value = 'all';
    syncDayFilterOptions();
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

  function escapeEntriesExcelXml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  }

  function entriesExcelColumnLabel(index) {
    let n = index;
    let label = '';
    while (n > 0) {
      const remainder = (n - 1) % 26;
      label = String.fromCharCode(65 + remainder) + label;
      n = Math.floor((n - 1) / 26);
    }
    return label;
  }

  function encodeEntriesUtf8(text) {
    return new TextEncoder().encode(String(text));
  }

  const ENTRIES_EXPORT_CRC_TABLE = (() => {
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

  function entriesExportCrc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      c = ENTRIES_EXPORT_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function entriesExportU16(value) {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, true);
    return out;
  }

  function entriesExportU32(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, true);
    return out;
  }

  function concatEntriesBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function buildEntriesZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBytes = encodeEntriesUtf8(entry.name);
      const dataBytes = entry.data instanceof Uint8Array ? entry.data : encodeEntriesUtf8(entry.data);
      const crc = entriesExportCrc32(dataBytes);
      const localHeader = concatEntriesBytes([entriesExportU32(0x04034b50), entriesExportU16(20), entriesExportU16(0), entriesExportU16(0), entriesExportU16(0), entriesExportU16(0), entriesExportU32(crc), entriesExportU32(dataBytes.length), entriesExportU32(dataBytes.length), entriesExportU16(nameBytes.length), entriesExportU16(0)]);
      localParts.push(localHeader, nameBytes, dataBytes);
      const centralHeader = concatEntriesBytes([entriesExportU32(0x02014b50), entriesExportU16(20), entriesExportU16(20), entriesExportU16(0), entriesExportU16(0), entriesExportU16(0), entriesExportU16(0), entriesExportU32(crc), entriesExportU32(dataBytes.length), entriesExportU32(dataBytes.length), entriesExportU16(nameBytes.length), entriesExportU16(0), entriesExportU16(0), entriesExportU16(0), entriesExportU16(0), entriesExportU32(0), entriesExportU32(offset)]);
      centralParts.push(centralHeader, nameBytes);
      offset += localHeader.length + nameBytes.length + dataBytes.length;
    }
    const centralDirectory = concatEntriesBytes(centralParts);
    const localData = concatEntriesBytes(localParts);
    const eocd = concatEntriesBytes([entriesExportU32(0x06054b50), entriesExportU16(0), entriesExportU16(0), entriesExportU16(entries.length), entriesExportU16(entries.length), entriesExportU32(centralDirectory.length), entriesExportU32(localData.length), entriesExportU16(0)]);
    return concatEntriesBytes([localData, centralDirectory, eocd]);
  }

  function entriesXmlInlineString(value, styleId = null) {
    const styleAttr = styleId === null ? '' : ' s="' + String(styleId) + '"';
    return '<c' + styleAttr + ' t="inlineStr"><is><t xml:space="preserve">' + escapeEntriesExcelXml(value) + '</t></is></c>';
  }

  function entriesXmlNumberCell(value, style = 1) {
    return '<c s="' + style + '" t="n"><v>' + String(Number(value || 0)) + '</v></c>';
  }

  function entriesXmlEmptyCell(styleId = null) {
    return styleId === null ? '<c/>' : '<c s="' + String(styleId) + '"/>';
  }

  function buildEntriesWorkbook(headers, rows, onStep) {
    const XLSX_MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const XLSX_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
    onStep?.('一覧データ整形');
    const numericColumns = new Set([0, 6]);
    const labelColorFillMap = {
      red: 'FFFFCCCC',
      yellow: 'FFFFFF00',
      green: 'FFE2EFDA',
      lightblue: 'FFDDEBF7',
      brown: 'FFBF8F00',
      blue: 'FFC6E0B4'
    };
    const fillEntries = Object.entries(labelColorFillMap);
    const rowStyleMap = new Map(fillEntries.map(([key], index) => {
      const fillId = index + 2;
      const textStyleId = index * 2 + 2;
      const numericStyleId = index * 2 + 3;
      return [key, { textStyleId, numericStyleId, fillId }];
    }));
    const sheetRows = [headers, ...rows].map((row, rowIndex) => {
      const labelColorKey = rowIndex > 0 ? String(row[12] || '') : '';
      const rowStyle = rowStyleMap.get(labelColorKey);
      const cells = row.map((value, cellIndex) => {
        if (value === null || value === undefined || value === '') {
          return entriesXmlEmptyCell(rowIndex > 0 && rowStyle ? rowStyle.textStyleId : null);
        }
        if (rowIndex > 0 && numericColumns.has(cellIndex) && typeof value === 'number' && Number.isFinite(value)) {
          return entriesXmlNumberCell(value, rowStyle?.numericStyleId ?? 1);
        }
        if (rowIndex > 0 && rowStyle) return entriesXmlInlineString(String(value), rowStyle.textStyleId);
        return entriesXmlInlineString(String(value));
      }).join('');
      return '<row r="' + String(rowIndex + 1) + '">' + cells + '</row>';
    }).join('');

    onStep?.('ワークシートXML生成');
    const usedRange = 'A1:' + entriesExcelColumnLabel(headers.length) + String(rows.length + 1);
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
      '<sheets><sheet name="予定一覧" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>';
    const workbookRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="' + PKG_REL_NS + '">' +
      '<Relationship Id="rId1" Type="' + XLSX_REL_NS + '/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="' + XLSX_REL_NS + '/styles" Target="styles.xml"/>' +
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
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>';
    const nowIso = new Date().toISOString();
    const coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>予定一覧</dc:title>' +
      '<dc:creator>Cashflow Manager</dc:creator>' +
      '<cp:lastModifiedBy>Cashflow Manager</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + nowIso + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + nowIso + '</dcterms:modified>' +
      '</cp:coreProperties>';
    const appXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>Cashflow Manager</Application>' +
      '<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>予定一覧</vt:lpstr></vt:vector></TitlesOfParts>' +
      '</Properties>';
    onStep?.('スタイルXML生成');
    const fillsXml = [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
      ...fillEntries.map(([, rgb]) => '<fill><patternFill patternType="solid"><fgColor rgb="' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>')
    ].join('');
    const cellXfsXml = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
      ...fillEntries.flatMap(([key]) => {
        const style = rowStyleMap.get(key);
        if (!style) return [];
        return [
          '<xf numFmtId="0" fontId="0" fillId="' + style.fillId + '" borderId="0" xfId="0" applyFill="1"/>',
          '<xf numFmtId="3" fontId="0" fillId="' + style.fillId + '" borderId="0" xfId="0" applyFill="1" applyNumberFormat="1"/>'
        ];
      })
    ].join('');
    const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="' + XLSX_MAIN_NS + '">' +
      '<fonts count="1"><font><sz val="11"/><name val="Yu Gothic"/></font></fonts>' +
      '<fills count="' + String(2 + fillEntries.length) + '">' + fillsXml + '</fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + String(2 + fillEntries.length * 2) + '">' + cellXfsXml + '</cellXfs>' +
      '</styleSheet>';
    onStep?.('ZIP組み立て');
    return buildEntriesZip([
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

  exportCsvBtn?.addEventListener('click', () => {
    const filtered = getFilteredEntries();
    if (filtered.length === 0) {
      showBanner(statusBanner, 'warn', '出力するデータがありません。');
      return;
    }
    const headers = ['ID', '予定日', '区分', 'CF区分', '件名', '内容', '金額', 'メモ', '入出金日', '顧客名', '担当社員名', '完了状態', 'ラベル', '管理番号'];
    const rows = filtered.map((e, idx) => [
      e.id || '',
      e.scheduled_date || '',
      e.type === 'income' ? '入金' : '出金',
      e.cf_category || '',
      e.title || '',
      e.content || '',
      e.amount || 0,
      e.note || '',
      e.actual_transaction_date || '',
      e.customer_name || '',
      e.staff_name || '',
      Number(e.is_completed) === 1 ? '完了' : '未完了',
      e.label_color || 'blue',
      e.import_management_no || ''
    ]);
    let exportStep = '開始前';
    try {
      exportStep = 'Excelワークブック生成';
      const workbookZip = buildEntriesWorkbook(headers, rows, (step) => {
        exportStep = step;
      });
      exportStep = 'Blob生成';
      const blob = new Blob([workbookZip], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      exportStep = 'ダウンロードURL生成';
      const url = URL.createObjectURL(blob);
      exportStep = 'ダウンロードリンク生成';
      const link = document.createElement('a');
      const exportDate = formatLocalDateIso(new Date()).replaceAll('-', '');
      const exportYear = String(yearInput.value || 'data');
      const exportSequence = String(nextEntriesExportSequence(exportYear, exportDate)).padStart(3, '0');
      link.href = url;
      link.download = 'cashflow_' + exportYear + '_' + exportDate + '-' + exportSequence + '.xlsx';
      link.style.visibility = 'hidden';
      exportStep = 'ダウンロード実行';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error('Entries Excel export failed', error);
      const detail = error instanceof Error ? (error.message || error.name) : String(error);
      showBanner(statusBanner, 'error', 'Excel出力に失敗しました。停止箇所: ' + exportStep + ' / 詳細: ' + detail);
    }
  });

  downloadMasterCsvBtn?.addEventListener('click', () => {
    const rows = [
      ['master_type', 'master_key', 'master_label', 'target', 'description', 'sort_order'],
      ...MASTER_CF_CATEGORIES.map((item) => [
        item.kind,
        item.key,
        item.label,
        item.target,
        item.description,
        String(item.sortOrder)
      ]),
      ...MASTER_LABEL_COLORS.map((item) => [
        item.kind,
        item.key,
        item.label,
        item.target,
        item.description,
        String(item.sortOrder)
      ])
    ];
    const csvContent = rows
      .map((row) => row.map((val) => '"' + String(val).replace(/"/g, '""') + '"').join(','))
      .join(String.fromCharCode(13, 10));
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cashflow_master.csv';
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
    const updated = await bulkUpdate('set_date', { scheduledDate: normalized }, '{count}件の予定日を更新しました。');
    if (updated) invalidateStatementFrame();
  });
  bulkEditActualDateBtn?.addEventListener('click', async () => {
    const normalized = await pickDateWithCalendar('', true);
    if (normalized == null) return;
    await bulkUpdate('set_actual_date', { actualTransactionDate: normalized }, '{count}件の確定日を更新しました。');
  });
  bulkEditCfCategoryBtn?.addEventListener('click', () => {
    showBulkCfCategoryModal();
  });
  bulkEditColorBtn?.addEventListener('click', () => {
    showBulkColorModal();
  });
  bulkCompleteBtn?.addEventListener('click', async () => {
    await bulkUpdate('set_completed', { isCompleted: true }, '{count}件を完了にしました。');
  });
  bulkUncompleteBtn?.addEventListener('click', async () => {
    await bulkUpdate('set_completed', { isCompleted: false }, '{count}件を未完了にしました。');
  });
  bulkCfCategoryClose?.addEventListener('click', () => closeModal(bulkCfCategoryModal));
  bulkCfCategoryCancel?.addEventListener('click', () => closeModal(bulkCfCategoryModal));
  bulkCfCategoryModal?.addEventListener('click', (ev) => {
    if (ev.target === bulkCfCategoryModal) closeModal(bulkCfCategoryModal);
  });
  bulkCfCategorySubmit?.addEventListener('click', async () => {
    const selection = getSelectedEntryTypeForBulkCf();
    if (!selection || !(bulkCfCategorySelect instanceof HTMLSelectElement)) return;
    const cfCategory = String(bulkCfCategorySelect.value || '').trim();
    closeModal(bulkCfCategoryModal);
    const updated = await bulkUpdate('set_cf_category', { cfCategory }, '{count}件のCF区分を更新しました。');
    if (updated) invalidateStatementFrame();
  });
  bulkColorClose?.addEventListener('click', () => closeModal(bulkColorModal));
  bulkColorCancel?.addEventListener('click', () => closeModal(bulkColorModal));
  bulkColorModal?.addEventListener('click', (ev) => {
    if (ev.target === bulkColorModal) closeModal(bulkColorModal);
  });
  bulkColorSubmit?.addEventListener('click', async () => {
    if (!(bulkColorSelect instanceof HTMLSelectElement)) return;
    const labelColor = String(bulkColorSelect.value || '').trim();
    closeModal(bulkColorModal);
    await bulkUpdate('set_label_color', { labelColor }, '{count}件の色ラベルを更新しました。');
  });

  function bindToggle(btn, section, labels = { collapsed: '開く', expanded: '折りたたむ' }) {
    const syncLabel = () => {
      btn.textContent = section.classList.contains('collapsed') ? labels.collapsed : labels.expanded;
    };
    syncLabel();
    btn.addEventListener('click', async () => {
      const isCollapsed = section.classList.toggle('collapsed');
      btn.textContent = isCollapsed ? labels.collapsed : labels.expanded;
      if (!isCollapsed && section === annualSectionBody) {
        await loadAnnualEntries(false);
      }
    });
  }

  bindToggle(toggleAnnualBtn, annualSectionBody, { collapsed: '展開する', expanded: '折りたたむ' });
  bindToggle(toggleListBtn, listSectionBody);

  listMoreBtn?.addEventListener('click', () => {
    visibleLimit += 300;
    renderRows();
  });

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

function renderCommonHeaderHtml(email: string, isAdmin: boolean, currentPath: string, options?: { showEditModeBtn?: boolean }): string {
  const items = [
    { href: '/app', label: 'Cashflow Manager', admin: false },
    { href: '/cashflow-statement', label: '資金繰り表', admin: false },
    { href: '/fiscal', label: '年間サマリー', admin: false },
    { href: '/admin/backups', label: 'バックアップ', admin: true },
    { href: '/admin/error-logs', label: 'エラーログ', admin: true },
    { href: '/audit', label: '監査ログ', admin: true }
  ];

  const linksHtml = items
    .filter((item) => !item.admin || isAdmin)
    .map((item) => {
      const isActive = item.href === currentPath;
      const activeStyle = isActive
        ? 'background:rgba(255,255,255,.2); font-weight:bold; border-color:#fff;'
        : 'background:rgba(255,255,255,.12);';
      return `<a href="${item.href}" style="display:inline-block; padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.35); color:#fff; text-decoration:none; font-size:13px; ${activeStyle}">${item.label}</a>`;
    });

  const editModeBtn = options?.showEditModeBtn
    ? `<button id="edit-mode-toggle" type="button" class="secondary" style="display:inline-flex; align-items:center; justify-content:center; padding:9px 12px; min-width:110px; border-radius:8px; border:1px solid rgba(255,255,255,.35); color:#fff; background:rgba(255,255,255,.12); font-size:13px; cursor:pointer; position:relative; z-index:30; pointer-events:auto; touch-action:manipulation; -webkit-tap-highlight-color:transparent;">編集モード</button>`
    : '';

  return `
<header style="position: sticky; top: 0; z-index: 20; background: linear-gradient(120deg, #0b3558 0%, #104b77 70%); color: #fff; padding: 14px 20px; box-shadow: 0 6px 20px rgba(10,36,64,0.08); font-family: 'Noto Sans JP', 'Hiragino Sans', sans-serif;">
  <div style="max-width: 1800px; margin: 0 auto; display: grid; grid-template-columns: 220px 1fr auto; gap: 18px; align-items: center;">
    <div style="min-width: 0;">
      <div style="font-size: 20px; font-weight: 700; letter-spacing: .02em;"><a href="/app" style="color:#fff; text-decoration:none;">Cashflow Manager</a></div>
      <div style="font-size: 12px; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(email)}">${escapeHtml(email)}</div>
    </div>
    <div style="display:flex; gap:8px; align-items:center; justify-content: flex-end;">
      ${linksHtml.join('\n      ')}
      ${editModeBtn}
      <form method="post" action="/logout" style="display:inline-flex; margin:0;">
        <button class="secondary" style="display:inline-flex; align-items:center; justify-content:center; padding:9px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.35); color:#fff; background:rgba(255,255,255,.12); font-size:13px; cursor:pointer;">ログアウト</button>
      </form>
      <a href="/password-change" style="display:inline-block; padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.35); color:#fff; text-decoration:none; font-size:13px; background:rgba(255,255,255,.12);">パスワード変更</a>
    </div>
  </div>
</header>
`;
}

function renderFiscalPage(email: string, isAdmin: boolean) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>年間サマリー | Cashflow</title>
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
${renderCommonHeaderHtml(email, isAdmin, '/fiscal')}
<main class="wrap" style="margin-top: 20px;">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:12px;">
    <div>
      <div class="title" style="font-size:24px; font-weight:700; margin:0;">年間サマリー</div>
      <div class="sub" style="color:var(--muted); font-size:13px; margin:0;">決算検討ダッシュボード</div>
    </div>
    <div class="filters" aria-label="決算期間選択" style="display:flex; gap:10px; align-items:center;">
      <select id="start-month" aria-label="開始月"></select>
      <select id="end-month" aria-label="終了月"></select>
      <button id="reload">更新</button>
    </div>
  </div>
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
  cashflowStatementData: CashflowStatementData,
  options?: { embedded?: boolean }
) {
  const embedded = options?.embedded === true;
  const now = new Date();
  const formattedToday = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const displayColumns = buildCashflowStatementDisplayColumns(2026, 2031, new Date());
  const printableMonthColumns = displayColumns.map((column, index) => ({ column, index }));
  const uncategorizedCount = cashflowStatementData.uncategorizedCount;
  const zeroDefaultRowNos = new Set([6, 7, 17, 32, 34, 45, 58, 59]);
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

  const printLayoutRules: Array<[string, string]> = [
    ['header, .sub, .head, .range-toolbar, .range-note, .range-alert, .table-scroll-x', 'display:none !important;'],
    ['.panel', 'max-width:none; margin:0; border:0; box-shadow:none; border-radius:0;'],
    ['.panel-body', 'display:none;'],
    ['table', 'width:auto !important; min-width:0; font-size:9px; margin:0 auto;'],
    ['th, td', 'padding:2px 5px;'],
    ['thead th', 'position:static;'],
    ['.sticky-col, .sticky-sub, .sticky-label, thead .sticky-col', 'position:static; left:auto;'],
    ['.sticky-label, .sticky-sub', 'width:1% !important; min-width:0 !important; max-width:none !important; white-space:nowrap !important;'],
    ['.table-wrap', 'overflow:visible; border-top:1px solid var(--line); zoom:var(--print-zoom, 1); max-height:none !important;'],
    ['.month-col', 'min-width:0;'],
    ['tr', 'break-inside:avoid;']
  ];
  const printMediaCss = printLayoutRules.map(([selector, declarations]) => `${selector} { ${declarations} }`).join('\n      ');
  const printEmulationCss = printLayoutRules
    .map(([selector, declarations]) => selector.split(',').map((part) => `body.print-emu ${part.trim()}`).join(', ') + ` { ${declarations} }`)
    .join('\n    ');

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
    .table-wrap { overflow:auto; border-top:1px solid var(--line); max-height:calc(100vh - 130px); }
    table { width:max-content; min-width:100%; border-collapse:separate; border-spacing:0; font-size:12px; }
    thead th { position:sticky; top:0; z-index:3; background:#f5f8fb; color:#334e68; font-weight:700; }
    thead tr:first-child th { top:0; }
    thead tr:nth-child(2) th { top:35px; }
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
      .wrap { padding:0 40px; }
      ${printMediaCss}
    }
    ${printEmulationCss}
    ${embedded ? `
    .wrap { padding: 0; }
    .head { display: none; }
    .panel { max-width: none; margin: 0; border: 0; border-radius: 0; box-shadow: none; }
    .panel-body { padding: 12px; }
    ` : ''}
  </style>
</head>
${embedded ? '' : renderCommonHeaderHtml(email, isAdmin, '/cashflow-statement')}
<main class="wrap" style="${embedded ? '' : 'margin-top: 20px;'}">
  ${embedded ? '' : `
  <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:14px; flex-wrap:wrap; gap:12px;">
    <div>
      <div class="title" style="font-size:24px; font-weight:700; margin:0;">資金繰り表</div>
      <div class="sub" style="color:var(--muted); font-size:13px; margin:0;">Excel原本をWebで再現したたたき台</div>
    </div>
    <div style="text-align:right; font-size:12px; color:#1d2733; line-height:1.5; font-weight:bold;">
      <div>発行日：${formattedToday}</div>
      <div>エイコーエナジオ株式会社</div>
    </div>
  </div>
  `}

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
  const IS_EMBEDDED = ${embedded ? 'true' : 'false'};
  const PRINT_AVAIL_WIDTH = 1527;
  const PRINT_AVAIL_HEIGHT = 1062;
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
    if (IS_EMBEDDED) {
      const startKey = String(rangeStartEl?.value || '');
      const endKey = String(rangeEndEl?.value || '');
      const printUrl = '/cashflow-statement?start=' + encodeURIComponent(startKey) + '&end=' + encodeURIComponent(endKey) + '&autoprint=1';
      const printWindow = window.open(printUrl, '_blank');
      if (!printWindow) {
        showRangeAlert('印刷用ページを開けませんでした。ポップアップを許可してください。');
        return;
      }
      showRangeAlert('印刷用ページを別タブで開きました。');
      return;
    }
    if (!applySelectedRange()) return;
    updatePrintZoom();
    showRangeAlert('印刷ダイアログを開いています。');
    window.setTimeout(() => window.print(), 0);
  }

  function buildExportFileName(extension) {
    const startKey = String(rangeStartEl?.value || '');
    const endKey = String(rangeEndEl?.value || '');
    const exportDate = formatLocalDateIso(new Date()).replaceAll('-', '');
    return 'cashflow_statement_' + startKey + '_to_' + endKey + '_' + exportDate + '.' + extension;
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

  function buildEntriesWorkbook(headers, rows, onStep) {
    onStep?.('一覧データ整形');
    const numericColumns = new Set([0, 6]);
    const labelColorFillMap = {
      red: 'FFFFCCCC',
      yellow: 'FFFFFF00',
      green: 'FFE2EFDA',
      lightblue: 'FFDDEBF7',
      brown: 'FFBF8F00',
      blue: 'FFC6E0B4'
    };
    const fillEntries = Object.entries(labelColorFillMap);
    const rowStyleMap = new Map(fillEntries.map(([key], index) => {
      const fillId = index + 2;
      const textStyleId = index * 2 + 2;
      const numericStyleId = index * 2 + 3;
      return [key, { textStyleId, numericStyleId, fillId }];
    }));
    const sheetRows = [headers, ...rows].map((row, rowIndex) => {
      const labelColorKey = rowIndex > 0 ? String(row[12] || '') : '';
      const rowStyle = rowStyleMap.get(labelColorKey);
      const cells = row.map((value, cellIndex) => {
        if (value === null || value === undefined || value === '') return '<c/>';
        if (rowIndex > 0 && numericColumns.has(cellIndex) && typeof value === 'number' && Number.isFinite(value)) {
          return xmlNumberCell(value, rowStyle?.numericStyleId ?? 1);
        }
        if (rowIndex > 0 && rowStyle) return '<c s="' + rowStyle.textStyleId + '" t="inlineStr"><is><t xml:space="preserve">' + escapeExcelXml(String(value)) + '</t></is></c>';
        return xmlInlineString(String(value));
      }).join('');
      return '<row r="' + String(rowIndex + 1) + '">' + cells + '</row>';
    }).join('');

    onStep?.('ワークシートXML生成');
    const usedRange = 'A1:' + toExcelColumnLabel(headers.length) + String(rows.length + 1);
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
      '<sheets><sheet name="予定一覧" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>';
    const workbookRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="' + PKG_REL_NS + '">' +
      '<Relationship Id="rId1" Type="' + XLSX_REL_NS + '/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="' + XLSX_REL_NS + '/styles" Target="styles.xml"/>' +
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
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>';
    const nowIso = new Date().toISOString();
    const coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>予定一覧</dc:title>' +
      '<dc:creator>Cashflow Manager</dc:creator>' +
      '<cp:lastModifiedBy>Cashflow Manager</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + nowIso + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + nowIso + '</dcterms:modified>' +
      '</cp:coreProperties>';
    const appXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>Cashflow Manager</Application>' +
      '<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>予定一覧</vt:lpstr></vt:vector></TitlesOfParts>' +
      '</Properties>';
    onStep?.('スタイルXML生成');
    const fillsXml = [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
      ...fillEntries.map(([, rgb]) => '<fill><patternFill patternType="solid"><fgColor rgb="' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>')
    ].join('');
    const cellXfsXml = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
      ...fillEntries.flatMap(([key]) => {
        const style = rowStyleMap.get(key);
        if (!style) return [];
        return [
          '<xf numFmtId="0" fontId="0" fillId="' + style.fillId + '" borderId="0" xfId="0" applyFill="1"/>',
          '<xf numFmtId="3" fontId="0" fillId="' + style.fillId + '" borderId="0" xfId="0" applyFill="1" applyNumberFormat="1"/>'
        ];
      })
    ].join('');
    const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="' + XLSX_MAIN_NS + '">' +
      '<fonts count="1"><font><sz val="11"/><name val="Yu Gothic"/></font></fonts>' +
      '<fills count="' + String(2 + fillEntries.length) + '">' + fillsXml + '</fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + String(2 + fillEntries.length * 2) + '">' + cellXfsXml + '</cellXfs>' +
      '</styleSheet>';
    onStep?.('ZIP組み立て');
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
          const row16 = rowNoToWorkbookRow.get(16);
          const row17 = rowNoToWorkbookRow.get(17);
          const row18 = rowNoToWorkbookRow.get(18);
          const row31 = rowNoToWorkbookRow.get(31);
          const row32 = rowNoToWorkbookRow.get(32);
          const row34 = rowNoToWorkbookRow.get(34);
          const row35 = rowNoToWorkbookRow.get(35);
          const row44 = rowNoToWorkbookRow.get(44);
          const row45 = rowNoToWorkbookRow.get(45);
          const row46 = rowNoToWorkbookRow.get(46);
          const row57 = rowNoToWorkbookRow.get(57);
          const row58 = rowNoToWorkbookRow.get(58);
          const row59 = rowNoToWorkbookRow.get(59);
          if (rowNo === 6) {
            if (monthCellIndex === 0 || !row59) return xmlNumberCell(0);
            return xmlFormulaCell(toExcelColumnLabel(monthColumnNumber - 1) + row59, numericValue);
          }
          if (rowNo === 7 && row8 && row16) return xmlFormulaCell('SUM(' + toExcelColumnLabel(monthColumnNumber) + row8 + ':' + toExcelColumnLabel(monthColumnNumber) + row16 + ')', numericValue);
          if (rowNo === 17 && row18 && row31) return xmlFormulaCell('SUM(' + toExcelColumnLabel(monthColumnNumber) + row18 + ':' + toExcelColumnLabel(monthColumnNumber) + row31 + ')', numericValue);
          if (rowNo === 32 && row7 && row17) return xmlFormulaCell(toExcelColumnLabel(monthColumnNumber) + row7 + '-' + toExcelColumnLabel(monthColumnNumber) + row17, numericValue);
          if (rowNo === 34 && row35 && row44) return xmlFormulaCell('SUM(' + toExcelColumnLabel(monthColumnNumber) + row35 + ':' + toExcelColumnLabel(monthColumnNumber) + row44 + ')', numericValue);
          if (rowNo === 45 && row46 && row57) return xmlFormulaCell('SUM(' + toExcelColumnLabel(monthColumnNumber) + row46 + ':' + toExcelColumnLabel(monthColumnNumber) + row57 + ')', numericValue);
          if (rowNo === 58 && row34 && row45) return xmlFormulaCell(toExcelColumnLabel(monthColumnNumber) + row34 + '-' + toExcelColumnLabel(monthColumnNumber) + row45, numericValue);
          if (rowNo === 59 && row6 && row32 && row58) return xmlFormulaCell(toExcelColumnLabel(monthColumnNumber) + row6 + '+' + toExcelColumnLabel(monthColumnNumber) + row32 + '+' + toExcelColumnLabel(monthColumnNumber) + row58, numericValue);
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

  function updatePrintZoom() {
    if (!statementTableEl || !document.body) return;
    document.documentElement.style.setProperty('--print-zoom', '1');
    const previousBodyWidth = document.body.style.width;
    document.body.classList.add('print-emu');
    document.body.style.width = PRINT_AVAIL_WIDTH + 'px';
    const rect = statementTableEl.getBoundingClientRect();
    document.body.classList.remove('print-emu');
    document.body.style.width = previousBodyWidth;
    if (!rect.width || !rect.height) return;
    const zoom = Math.min(1, PRINT_AVAIL_WIDTH / rect.width, PRINT_AVAIL_HEIGHT / rect.height);
    document.documentElement.style.setProperty('--print-zoom', String(Math.floor(zoom * 1000) / 1000));
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
  const pageParams = new URLSearchParams(window.location.search);
  const urlStartKey = String(pageParams.get('start') || '');
  const urlEndKey = String(pageParams.get('end') || '');
  const shouldAutoprint = pageParams.get('autoprint') === '1';
  if (rangeStartEl && printableMonthKeys.includes(urlStartKey)) rangeStartEl.value = urlStartKey;
  if (rangeEndEl && printableMonthKeys.includes(urlEndKey)) rangeEndEl.value = urlEndKey;
  applySelectedRange();
  syncStatementScrollMetrics();
  if (shouldAutoprint && !IS_EMBEDDED) {
    updatePrintZoom();
    showRangeAlert('印刷ダイアログを開いています。');
    window.setTimeout(() => window.print(), 250);
  }
  topScrollEl?.addEventListener('scroll', syncTableScrollFromTop, { passive: true });
  tableWrapEl?.addEventListener('scroll', syncTopScrollFromTable, { passive: true });
  applyRangeBtn?.addEventListener('click', applySelectedRange);
  printPdfBtn?.addEventListener('click', handlePrintPdf);
  exportExcelBtn?.addEventListener('click', handleExportExcel);
  window.addEventListener('resize', syncStatementScrollMetrics);
  window.addEventListener('beforeprint', updatePrintZoom);
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
    .tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#eef4ff;color:#265d9c}
    .tag.add{background:#edf9f1;color:var(--ok)}
    .tag.edit{background:#eef4ff;color:#265d9c}
    .tag.delete{background:#fef0f1;color:var(--warn)}
    .muted{color:var(--muted)}
  </style>
</head>
${renderCommonHeaderHtml(email, true, '/audit')}
<main class="wrap" style="margin-top: 20px;">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:12px;">
    <div>
      <div class="title" style="font-size:24px; font-weight:700; margin:0;">監査ログ</div>
      <div class="sub" style="color:var(--muted); font-size:13px; margin:0;">ログイン履歴と操作履歴を確認</div>
    </div>
  </div>

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

type AppErrorLogFilters = {
  from: string | null;
  to: string | null;
  source: string;
  search: string;
};

async function listAppErrorLogs(db: D1Database, organizationId: number, filters: AppErrorLogFilters): Promise<AppErrorLogRow[]> {
  const clauses = ['e.organization_id = ?'];
  const bindValues: Array<string | number | null> = [organizationId];

  if (filters.from) {
    clauses.push('e.created_at >= ?');
    bindValues.push(toAuditUtcStart(filters.from));
  }
  if (filters.to) {
    clauses.push('e.created_at < ?');
    bindValues.push(toAuditUtcEndExclusive(filters.to));
  }
  if (filters.source) {
    clauses.push('e.source = ?');
    bindValues.push(filters.source);
  }
  if (filters.search) {
    clauses.push('(e.message LIKE ? OR e.path LIKE ? OR e.detail LIKE ? OR COALESCE(e.request_id, \'\') LIKE ?)');
    const like = `%${filters.search}%`;
    bindValues.push(like, like, like, like);
  }

  const rows = await db.prepare(
    `SELECT
      e.id,
      e.request_id,
      e.user_id,
      e.organization_id,
      u.email AS user_email,
      o.name AS organization_name,
      e.source,
      e.level,
      e.method,
      e.path,
      e.status_code,
      e.message,
      e.error_name,
      e.stack,
      e.detail,
      e.created_at
     FROM app_error_logs e
     LEFT JOIN users u ON u.id = e.user_id
     LEFT JOIN organizations o ON o.id = e.organization_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT 200`
  ).bind(...bindValues).all<AppErrorLogRow>();

  return rows.results ?? [];
}

function renderErrorLogsPage(email: string, logs: AppErrorLogRow[], filters: AppErrorLogFilters) {
  const sources = ['', 'onError', 'csv-import', 'csv-import-preview', 'csv-import-commit', 'backup-create', 'backup-restore', 'scheduled-job'];
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>エラーログ | Cashflow</title>
  <style>
    :root { --bg:#eef2f6; --panel:#fff; --line:#d4dde7; --text:#1d2733; --muted:#5e7188; --accent:#0f4c81; --warn:#b22a34; }
    *{box-sizing:border-box}
    body{margin:0;font-family:"Noto Sans JP","Hiragino Sans",sans-serif;background:linear-gradient(180deg,#f7f9fc 0%, var(--bg) 100%);color:var(--text)}
    .wrap{max-width:1280px;margin:0 auto;padding:18px 16px 36px}
    .head{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:14px}
    .title{font-size:30px;font-weight:700}
    .sub{font-size:13px;color:var(--muted)}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .actions a,.actions button,.actions select,.actions input{padding:9px 10px;border:1px solid #b9c8d9;border-radius:8px;background:#fff;color:var(--text);font-size:14px;text-decoration:none}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
    .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .toolbar label{font-size:12px;color:var(--muted)}
    .table-wrap{overflow:auto;border:1px solid #e1e8f0;border-radius:10px;margin-top:10px}
    table{width:100%;border-collapse:collapse;font-size:13px;min-width:1200px}
    th,td{border-bottom:1px solid #e7edf4;text-align:left;padding:9px 8px;vertical-align:top}
    th{background:#f5f8fb;font-weight:700;color:#334e68}
    .tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
    .tag.error{background:#fef0f1;color:var(--warn)}
    .tag.warn{background:#fff4db;color:#8b5e00}
    .muted{color:var(--muted)}
    .stack{white-space:pre-wrap;max-width:440px;max-height:180px;overflow:auto;background:#f8fafc;border:1px solid #e1e8f0;border-radius:8px;padding:8px;font-size:12px;line-height:1.5}
    .summary{font-size:13px;color:var(--muted)}
  </style>
</head>
${renderCommonHeaderHtml(email, true, '/admin/error-logs')}
<main class="wrap" style="margin-top: 20px;">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:12px;">
    <div>
      <div class="title" style="font-size:24px; font-weight:700; margin:0;">エラーログ</div>
      <div class="sub" style="color:var(--muted); font-size:13px; margin:0;">Worker の例外・CSV取込み失敗・バックアップ失敗などを確認できます</div>
    </div>
  </div>

  <section class="panel">
    <form class="toolbar" method="get" action="/admin/error-logs">
      <label>開始日 <input name="from" type="date" value="${escapeHtml(filters.from || '')}" /></label>
      <label>終了日 <input name="to" type="date" value="${escapeHtml(filters.to || '')}" /></label>
      <label>発生源
        <select name="source">
          ${sources.map((source) => `<option value="${escapeHtml(source)}"${source === filters.source ? ' selected' : ''}>${escapeHtml(source || 'すべて')}</option>`).join('')}
        </select>
      </label>
      <label>検索 <input name="search" type="text" value="${escapeHtml(filters.search || '')}" placeholder="message / path / request id" /></label>
      <button type="submit">更新</button>
    </form>
    <div class="summary" style="margin-top:10px;">表示件数: ${logs.length}</div>
  </section>

  <section class="panel">
    <div class="table-wrap">
      ${logs.length > 0 ? `
      <table>
        <thead>
          <tr>
            <th>時刻</th>
            <th>ユーザー</th>
            <th>組織</th>
            <th>発生源</th>
            <th>レベル</th>
            <th>Request ID</th>
            <th>Method</th>
            <th>Path</th>
            <th>Status</th>
            <th>Message</th>
            <th>Detail</th>
            <th>Stack</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map((log) => `
            <tr>
              <td>${escapeHtml(formatJstDateTime(log.created_at))}</td>
              <td>${escapeHtml(log.user_email || '-')}</td>
              <td>${escapeHtml(log.organization_name || '-')}</td>
              <td><span class="tag">${escapeHtml(log.source)}</span></td>
              <td><span class="tag ${escapeHtml(log.level)}">${escapeHtml(log.level)}</span></td>
              <td class="muted">${escapeHtml(log.request_id || '-')}</td>
              <td>${escapeHtml(log.method || '-')}</td>
              <td>${escapeHtml(log.path || '-')}</td>
              <td>${escapeHtml(String(log.status_code ?? '-'))}</td>
              <td>${escapeHtml(log.message)}</td>
              <td class="muted">${escapeHtml(log.detail || '-')}</td>
              <td>${log.stack ? `<div class="stack">${escapeHtml(log.stack)}</div>` : '<span class="muted">-</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ` : `<div class="empty" style="padding:18px;color:var(--muted);text-align:center;">まだログはありません。</div>`}
    </div>
  </section>
</main>
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
${renderCommonHeaderHtml(email, true, '/admin/backups')}
<main class="wrap" style="margin-top: 20px;">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:12px;">
    <div>
      <div class="title" style="font-size:24px; font-weight:700; margin:0;">バックアップ管理</div>
      <div class="sub" style="color:var(--muted); font-size:13px; margin:0;">明細だけを毎日23:59(JST)に自動保存し、${CASHFLOW_BACKUP_RETENTION_DAYS}日で自動削除します</div>
    </div>
  </div>

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
    ['売電収入（茨城発電所）', 15],
    ['その他の収入（社長）', 16]
  ]);
  const operatingExpenseRowMap = new Map<string, number>([
    ['現金仕入', 18],
    ['買掛金支払', 19],
    ['未払金・前渡金支払', 21],
    ['人件費支出', 22],
    ['家賃等', 23],
    ['固定費', 24],
    ['租税公課', 25],
    ['その他の支出（社長）', 26],
    ['その他の支出（UFJ）', 27],
    ['その他の支出（木下）', 28],
    ['その他の支出（その他）', 29],
    ['保険料', 30],
    ['業務委託費', 31]
  ]);
  const financingIncomeRowMap = new Map<string, number>([
    ['固定性預金払戻し', 35],
    ['銀行借入', 36],
    ['E借入', 39],
    ['E借入（事業分）', 40],
    ['E借入（非事業分）', 41],
    ['売電事業分資金移動', 42],
    ['設備収入（設備売却など）', 43],
    ['その他の財務等収入', 44]
  ]);
  const financingExpenseRowMap = new Map<string, number>([
    ['銀行借入返済', 46],
    ['E借入', 49],
    ['E借入（事業分）', 50],
    ['E借入（非事業分）', 51],
    ['設備支出（固定資産投資）', 52],
    ['その他の財務等支出', 53],
    ['利息保証料支払', 54],
    ['リース債務返済', 55]
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
      if (entry.type === 'income') {
        if (CASHFLOW_STATEMENT_OPERATING_INCOME_CATEGORIES.has(entry.cfCategory)) {
          operatingIncome += entry.amount;
          hasOperatingIncomeEntry = true;
          const rowNo = operatingIncomeRowMap.get(entry.cfCategory);
          if (rowNo) addItemRowValue(rowNo, monthKey, entry.amount);
        } else if (CASHFLOW_STATEMENT_FINANCING_INCOME_CATEGORIES.has(entry.cfCategory)) {
          financingIncome += entry.amount;
          hasFinancingIncomeEntry = true;
          const rowNo = financingIncomeRowMap.get(entry.cfCategory);
          if (rowNo) addItemRowValue(rowNo, monthKey, entry.amount);
        }
      } else {
        if (CASHFLOW_STATEMENT_OPERATING_EXPENSE_CATEGORIES.has(entry.cfCategory)) {
          operatingExpense += entry.amount;
          hasOperatingExpenseEntry = true;
          const rowNo = operatingExpenseRowMap.get(entry.cfCategory);
          if (rowNo) addItemRowValue(rowNo, monthKey, entry.amount);
        } else if (CASHFLOW_STATEMENT_FINANCING_EXPENSE_CATEGORIES.has(entry.cfCategory)) {
          financingExpense += entry.amount;
          hasFinancingExpenseEntry = true;
          const rowNo = financingExpenseRowMap.get(entry.cfCategory);
          if (rowNo) addItemRowValue(rowNo, monthKey, entry.amount);
        }
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
  valuesByRowNo.set(17, new Map(Array.from(operatingExpenseByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(32, new Map(Array.from(operatingNetByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(34, new Map(Array.from(financingIncomeByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(45, new Map(Array.from(financingExpenseByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(58, new Map(Array.from(financingNetByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));
  valuesByRowNo.set(59, new Map(Array.from(closingByMonth.entries()).map(([monthKey, value]) => [monthKey, value])));

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

function getYearDateRange(year: string): { startDate: string; endDate: string } {
  return {
    startDate: `${year}-01-01`,
    endDate: `${String(Number(year) + 1)}-01-01`
  };
}

function getMonthDateRange(month: string): { startDate: string; endDate: string } {
  const [year, mm] = month.split('-');
  const current = new Date(Date.UTC(Number(year), Number(mm) - 1, 1));
  const next = new Date(Date.UTC(Number(year), Number(mm), 1));
  return {
    startDate: current.toISOString().slice(0, 10),
    endDate: next.toISOString().slice(0, 10)
  };
}

function parseDateOnly(date?: string | null): string | null {
  const d = (date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const parsed = new Date(`${d}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== d) return null;
  return d;
}

function parseNormalizedAmount(value: unknown): { digits: string, amount: number | null } {
  // 数値型が渡された場合は直接数値として検証する
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > MAX_AMOUNT) {
      return { digits: String(value), amount: null };
    }
    return { digits: String(value), amount: value };
  }
  const digits = String(value ?? '')
    .normalize('NFKC')
    .replace(/[^\d]/g, '');
  if (!/^[1-9]\d*$/.test(digits)) {
    return { digits, amount: null };
  }
  const amount = Number(digits);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
    return { digits, amount: null };
  }
  return { digits, amount };
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

function parseCsvRecords(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '"') {
      if (inQuote && normalized[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }

    if (!inQuote && ch === ',') {
      record.push(cell);
      cell = '';
      continue;
    }

    if (!inQuote && ch === '\n') {
      record.push(cell);
      if (record.length > 1 || record[0] !== '') {
        records.push(record);
      }
      record = [];
      cell = '';
      continue;
    }

    cell += ch;
  }

  record.push(cell);
  if (record.length > 1 || record[0] !== '') {
    records.push(record);
  }

  return records;
}

function parseRakurakuCsvText(text: string): Array<{
  managementNo?: string;
  projectName?: string;
  expenseTotalInclTax?: number | null;
  incomeTotalInclTax?: number | null;
  customerName?: string;
  scheduledDateRaw?: string;
}> {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.csvEmpty, 'CSVファイルが空です。');
  }
  if (records.length === 1) {
    throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.csvEmpty, 'CSVデータ行がありません。');
  }
  const header = records[0].map((cell) => cell.replace(/^\uFEFF/, '').trim());
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
  for (let i = 1; i < records.length; i += 1) {
    const cols = records[i] ?? [];
    if (cols.every((cell) => String(cell ?? '').trim() === '')) continue;
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

function parseCashflowImportCsvText(text: string): CashflowImportParsedRow[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.csvEmpty, 'CSVファイルが空です。');
  }
  if (records.length === 1) {
    throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.csvEmpty, 'CSVデータ行がありません。');
  }

  const header = records[0].map((cell) => cell.replace(/^\uFEFF/, '').trim());
  const idx = {
    id: header.indexOf('ID'),
    scheduledDate: header.indexOf('予定日'),
    type: header.indexOf('区分'),
    cfCategory: header.indexOf('CF区分'),
    title: header.indexOf('件名'),
    content: header.indexOf('内容'),
    amount: header.indexOf('金額'),
    note: header.indexOf('メモ'),
    actualDate: header.indexOf('入出金日'),
    customerName: header.indexOf('顧客名'),
    staffName: header.indexOf('担当社員名'),
    completed: header.indexOf('完了状態'),
    labelColor: header.indexOf('ラベル'),
    managementNo: header.indexOf('管理番号')
  };

  if (idx.scheduledDate < 0 || idx.type < 0 || idx.title < 0 || idx.amount < 0) {
    throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.csvHeaderMismatch, 'CSVヘッダーに必要な項目（予定日, 区分, 件名, 金額）が含まれていません。');
  }

  const rows: CashflowImportParsedRow[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const cols = records[i] ?? [];
    if (cols.every((cell) => String(cell ?? '').trim() === '')) continue;

    const id = idx.id >= 0 ? String(cols[idx.id] ?? '').trim() : '';
    const rawScheduledDate = String(cols[idx.scheduledDate] ?? '').trim();
    const rawType = String(cols[idx.type] ?? '').trim();
    const title = String(cols[idx.title] ?? '').trim();
    const rawAmountVal = String(cols[idx.amount] ?? '').replaceAll(',', '').trim();
    const amount = Number(rawAmountVal);
    const note = idx.note >= 0 ? String(cols[idx.note] ?? '').trim() : '';
    const actualDate = idx.actualDate >= 0 ? String(cols[idx.actualDate] ?? '').trim() : '';
    const customerName = idx.customerName >= 0 ? String(cols[idx.customerName] ?? '').trim() : '';
    const staffName = idx.staffName >= 0 ? String(cols[idx.staffName] ?? '').trim() : '';
    const completed = idx.completed >= 0 ? String(cols[idx.completed] ?? '').trim() : '';
    const labelColor = idx.labelColor >= 0 ? String(cols[idx.labelColor] ?? '').trim() : '';
    const managementNo = idx.managementNo >= 0 ? String(cols[idx.managementNo] ?? '').trim() : '';
    const cfCategory = idx.cfCategory >= 0 ? String(cols[idx.cfCategory] ?? '').trim() : '';
    const content = idx.content >= 0 ? String(cols[idx.content] ?? '').trim() : '';

    const scheduledDate = parseSlashOrIsoDate(rawScheduledDate);
    if (!scheduledDate) {
      throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.internalError, `予定日の日付形式が正しくありません。${i + 1}行目`);
    }
    let type: 'income' | 'expense';
    if (rawType === '入金') {
      type = 'income';
    } else if (rawType === '出金') {
      type = 'expense';
    } else {
      throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.internalError, `区分は「入金」または「出金」で入力してください。${i + 1}行目`);
    }
    if (title === '') {
      throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.internalError, `件名が入力されていません。${i + 1}行目`);
    }
    if (rawAmountVal === '' || isNaN(amount) || amount < 0) {
      throw new CsvImportParseError(CSV_IMPORT_ERROR_CODES.internalError, `金額が正しくありません（1以上の整数）。${i + 1}行目`);
    }

    rows.push({
      rowNumber: i + 1,
      id,
      scheduledDate,
      type,
      title: title.slice(0, 120),
      content: content.slice(0, MAX_CONTENT_LENGTH),
      amount,
      note: note || '',
      actualDate: parseSlashOrIsoDate(actualDate) || '',
      customerName: customerName || '',
      staffName: staffName || '',
      isCompleted: completed === '完了' ? 1 : 0,
      labelColor: labelColor || '',
      managementNo: managementNo || '',
      cfCategory: cfCategory || '',
      cfCategorySpecified: idx.cfCategory >= 0
    });
  }

  return rows;
}

function buildCashflowImportMatchKey(row: {
  scheduledDate: string;
  type: 'income' | 'expense';
  title: string;
  content: string;
  amount: number;
  note: string;
  actualDate: string;
  customerName: string;
  staffName: string;
  labelColor: string;
  cfCategory: string;
  isCompleted: number;
  managementNo: string;
}): string {
  return [
    row.scheduledDate,
    row.type,
    row.title,
    row.content,
    String(row.amount),
    row.note,
    row.actualDate,
    row.customerName,
    row.staffName,
    row.labelColor,
    row.cfCategory,
    String(row.isCompleted),
    row.managementNo
  ].join('\u0001');
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
  content: string;
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
  content: string;
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
    input.content.length <= MAX_CONTENT_LENGTH &&
    input.note.length <= MAX_NOTE_LENGTH &&
    allowedAccounts.has(input.accountName) &&
    input.accountName.length <= 80 &&
    input.customerName.length <= 80 &&
    input.staffName.length <= 80 &&
    allowedColors.has(input.labelColor) &&
    categories.has(input.cfCategory) &&
    Number.isInteger(input.amount) &&
    Number(input.amount) >= 1 &&
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
